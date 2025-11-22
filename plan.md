# StorageRepository を拡張して S3 などのオブジェクトストレージをサポートする改修方針

## 全体方針

- **目的**: 既存の `StorageRepository` / `StorageCore` を活かしつつ、環境変数で選択可能なストレージ backend (default: local / 追加: S3) を導入し、Immich 管理ファイル（オリジナル・サムネイル・エンコード動画・サイドカー等）を S3 に保存できるようにする。
- **基本思想**
  - **単一ファイルのみ変更**: アップストリームの変更を取り込みやすくするため、`storage.repository.ts` のみを変更する。
  - **パスをそのまま使用**: `StorageRepository` に渡されるパスをそのまま S3 オブジェクトキーとして使用し、`s3://<bucket_name>/` の配下に保存する。
  - **backend 判定は各メソッド内**: 抽象化層を作らず、各メソッドの先頭で環境変数を確認し、S3 または Local の処理に分岐する。
  - **ローカル FS ユーティリティは維持**: ライブラリスキャンや `watch` などローカル FS 前提の機能は、S3 backend 選択時もローカル FS を対象とし、Immich が管理するメディア保存先のみを S3 に切り替える。

## 設計変更の概要

- **単一ファイル変更の方針**
  - アップストリームの変更を取り込みやすくするため、**`storage.repository.ts` のみ**を変更する。
  - 抽象化層やインターフェース分離はファイル内で行う。
- **パスの扱い**
  - `StorageRepository` に渡されるパスをそのまま S3 オブジェクトキーとして使用する。
  - Local backend では従来通りファイルパスとして扱い、S3 backend では `s3://<bucket_name>/` の配下に保存する。
- **実装方針**
  - 既存のコードは `StorageRepository` を利用するため、外部から見た時の仕様や挙動は維持する。
  - S3 用のクラスを用意し、環境変数で S3 の利用が支持された場合に内部的に仕様するクラスを切り替える。
  - ローカル FS 専用のユーティリティメソッド（`crawl`, `walk`, `watch`, `checkDiskUsage` など）はそのまま残す。

## 環境変数・設定周りの設計

- **新しい環境変数 (案)**
  - `IMMICH_STORAGE_BACKEND`: `local` | `s3`、デフォルトは `local`。
  - S3 用: `IMMICH_S3_ENDPOINT`(任意 / MinIO 等)、`IMMICH_S3_REGION`、`IMMICH_S3_BUCKET`、`IMMICH_S3_ACCESS_KEY`、`IMMICH_S3_SECRET_KEY`、`IMMICH_S3_FORCE_PATH_STYLE` など。
- **`server/src/config.ts` への反映**
  - 上記環境変数を読み込み、設定スキーマ／型 (`SystemConfig` 相当) にフィールドを追加する。
  - 既存の `storageTemplate` / `mediaLocation` との関係を整理し、S3 backend では `mediaLocation` を「論理プレフィックス」として扱うことを明記する。

## StorageRepository / StorageCore 周りの改修

- **`StorageRepository` の変更** (`server/src/repositories/storage.repository.ts`)
  - コンストラクタで環境変数から backend 種別（`local` or `s3`）を読み込み、S3 の場合は `S3Client` を初期化する。
    - Local の場合: 従来通り `node:fs/promises` を使用
    - S3 の場合: 対応する S3 コマンド（`GetObjectCommand`, `PutObjectCommand`, `CopyObjectCommand`, `DeleteObjectCommand`, `HeadObjectCommand` など）を実行
  - ローカル FS 専用メソッド（`crawl`, `walk`, `watch`, `checkDiskUsage`, `mkdirSync`, `existsSync`, `removeEmptyDirs`, `readdir`, `realpath` など）はそのまま維持。
- **`StorageCore` の変更不要** (`server/src/cores/storage.core.ts`)
  - パス生成ロジックはそのまま維持。`StorageRepository` がパスを受け取って適切な backend で処理する。
  - S3 backend では `StorageCore` が生成するパスをそのまま S3 オブジェクトキーとして使用。
- **他のサービスの変更不要**
  - `StorageTemplateService` など既存のサービスは `StorageRepository` のインターフェースが変わらないため、変更不要。

## S3 backend 実装の概要

- **S3 クライアント初期化**
  - `StorageRepository` のコンストラクタで環境変数を読み込み、S3 backend の場合は `S3Client` を初期化する。
  - バケット名、リージョン、エンドポイント、認証情報などを環境変数から取得。
  - IAM Role を利用可能にする、
- **メソッド実装時の注意事項**
  - ファイルの中身が不要なメソッドの場合は `HeadObjectCommand` を利用する。
  - S3 で Rename は許可されていないため `CopyObjectCommand` と `DeleteObjectCommand` でエミュレートする。
  - S3 でディレクトリは作成できないため、マーカーファイル `.immich` を作成する。
- **パスとキーのマッピング**
  - `StorageCore` から渡されるパスをそのまま S3 オブジェクトキーとして使用。
  - 必要に応じてパスの先頭の `/` をトリムする処理を `StorageRepository` 内に追加。

## テスト・検証方針

- **ユニットテスト**
  - `StorageRepository` の spec (`server/src/repositories/storage.repository.spec.ts`) を backend 抽象に合わせて整理する。
  - `LocalStorageBackend`: 既存挙動と互換性があることを確認するテストを維持。
  - `CloudStorageBackend`: S3 クライアントをモックし、主要メソッドが正しい AWS コマンドを呼び出すことを検証。
- **統合テスト / 手動検証**
  - `IMMICH_STORAGE_BACKEND=local` で現行動作が維持されることを確認（リグレッション防止）。
  - `IMMICH_STORAGE_BACKEND=s3` で実際の S3 / MinIO を用いた E2E 検証（アップロード／ダウンロード／サムネ生成／ライブフォトなど）。

## ドキュメンテーション

- **`docs` への追記**
  - 新しい環境変数と意味、S3 backend の前提条件（バケット作成、権限設定、S3 互換ストレージの注意点）を記載。
  - Local / S3 切替時の制約（既存ローカルファイルの自動移行は別途ジョブが必要、`watch` はローカル FS のみ等）を明文化する。
