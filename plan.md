<!-- e5b0eb24-997f-4544-aeb3-6b3dd50d5568 ecdd874a-57cb-4f0e-917e-f0bf79155d8e -->
# StorageRepository を拡張して S3 などのオブジェクトストレージをサポートする改修方針

## 全体方針

- **目的**: 既存の `StorageRepository` / `StorageCore` を活かしつつ、環境変数で選択可能なストレージ backend (default: local / 追加: S3) を導入し、Immich 管理ファイル（オリジナル・サムネイル・エンコード動画・サイドカー等）を S3 に保存できるようにする。
- **基本思想**
  - 「どこに置くか」（Local/S3）と「どんなパス構造にするか」（`StorageCore` のパス設計）を分離する。
  - DB に保存されるパス文字列は **論理パス (= StorageCore が組み立てるパス)** とし、Local backend ではファイルパス、S3 backend ではバケット内オブジェクトキーとして扱う。
  - ライブラリスキャンや `watch` などローカル FS 前提の機能は、S3 backend 選択時もローカル FS を対象とし、Immich が管理するメディア保存先のみを S3 に切り替える。

## 設計変更の概要

- **ストレージ backend の抽象化**
  - `StorageRepository` を「ローカル FS ユーティリティ」 + 「メディア保存抽象」の 2 層に整理する。
  - 例: `IMediaStorageBackend` インターフェースを設け、Immich 管理メディアの操作を集約 (`createReadStream`, `createWriteStream`, `createFile`, `createOrOverwriteFile`, `overwriteFile`, `readFile`, `writeFile`, `stat`, `rename`, `copyFile`, `utimes`, `unlink` など、実際に `StorageCore` / `StorageTemplateService` から呼ばれるものに限定)。
  - `StorageRepository` は Nest の provider 名を維持しつつ `IMediaStorageBackend` に委譲するか、`StorageRepository` を local backend とみなして `MEDIA_STORAGE` のような DI トークンで抽象化する。
- **backend 実装クラス**
  - `LocalStorageBackend`: 現状の `node:fs/promises` ベース実装を抽出。
  - `CloudStorageBackend`: `@aws-sdk/client-s3` 等を利用した S3 実装。
- **ローカル FS ユーティリティの扱い**
  - `crawl`, `walk`, `watch`, `checkDiskUsage`, `mkdirSync`, `existsSync`, `removeEmptyDirs` などホスト FS 前提のメソッドは、S3 backend でもローカル FS 用ユーティリティとしてそのまま維持する（ライブラリの読み取りや一時ファイルは別レイヤーとみなす）。

## 環境変数・設定周りの設計

- **新しい環境変数 (案)**
  - `IMMICH_STORAGE_BACKEND`: `local` | `s3`、デフォルトは `local`。
  - S3 用: `IMMICH_S3_ENDPOINT`(任意 / MinIO 等)、`IMMICH_S3_REGION`、`IMMICH_S3_BUCKET`、`IMMICH_S3_ACCESS_KEY`、`IMMICH_S3_SECRET_KEY`、`IMMICH_S3_FORCE_PATH_STYLE` など。
- **`server/src/config.ts` への反映**
  - 上記環境変数を読み込み、設定スキーマ／型 (`SystemConfig` 相当) にフィールドを追加する。
  - 既存の `storageTemplate` / `mediaLocation` との関係を整理し、S3 backend では `mediaLocation` を「論理プレフィックス」として扱うことを明記する。

## StorageRepository / StorageCore 周りの改修

- **`StorageRepository` の役割整理** (`server/src/repositories/storage.repository.ts`)
  - 既存メソッドを用途別に分類:  
    a) Immich 管理メディア用 (`createReadStream`, `createFile`, `createWriteStream`, `createOrOverwriteFile`, `overwriteFile`, `rename`, `copyFile`, `stat`, `utimes`, `unlink` など)。  
    b) ライブラリスキャン／ユーティリティ用 (`crawl`, `walk`, `watch`, `checkDiskUsage`, `mkdirSync`, `existsSync`, `removeEmptyDirs`, `readdir`, `realpath` など)。
  - a) を `IMediaStorageBackend` に切り出し、`StorageRepository` は `this.backend` に委譲。b) はローカル FS 固定のユーティリティとして残す。
- **`StorageCore` の変更最小化** (`server/src/cores/storage.core.ts`)
  - 「パス構造計算」と「move ロジック」に集中させ、ファイル実体操作 (`stat`, `rename`, `copyFile`, `unlink`, `utimes`) は backend 経由に統一。
  - S3 backend では `StorageCore` が生成する論理パスを S3 キーとして扱い、`mediaLocation` はバケット内 prefix として解釈する。
- **`StorageTemplateService` などの確認**
  - `StorageTemplateService` (`server/src/services/storage-template.service.ts`) などで `stat` / `checkFileExists` / 移動処理が backend 抽象に従うよう調整する。

## S3 backend 実装の概要

- **S3 クライアント初期化**
  - `CloudStorageBackend` 内で `S3Client` を生成し、バケット・リージョン・認証情報を環境変数から読み込む。初期はシンプル実装で、必要に応じて DI プロバイダへ切り出す。
- **主要メソッド実装方針**
  - `createReadStream(path)`: `GetObjectCommand` の Body (Readable) を `ImmichReadStream` にマッピングし、`ContentLength` / `ContentType` を付与。
  - `createWriteStream(path)`: `@aws-sdk/lib-storage` の `Upload` などでストリームアップロード。初期は一時ファイルを挟まない同期アップロードで正しさ優先。
  - `createFile` / `createOrOverwriteFile` / `overwriteFile`: Buffer を `PutObjectCommand` に渡す。
  - `stat(path)` / `checkFileExists(path)`: `HeadObjectCommand` でサイズ・更新時刻など最小限の情報を取得。
  - `rename(oldPath, newPath)`: `CopyObject` + `DeleteObject` でエミュレートし、既存の `EXDEV` フォールバックと整合させる。
  - `copyFile(oldPath, newPath)`: `CopyObjectCommand` を利用。
  - `unlink(path)`: `DeleteObjectCommand` を利用。
- **パスとキーのマッピング**
  - `StorageCore` が組み立てる論理パス (例: `/data/library/<user>/<year>/...`) をそのまま S3 オブジェクトキーとして利用。
  - `mediaLocation` を prefix にする場合は `/` をトリムし、`mediaLocation` + 相対パスへ変換するユーティリティを backend 内に置く。

## DI 構成とバックエンド切替

- **NestJS の provider 構成**
  - 例: `MEDIA_STORAGE` InjectionToken を追加し、`IMMICH_STORAGE_BACKEND` が `local` のときは `LocalStorageBackend`、`s3` のときは `CloudStorageBackend` をバインドする。
  - `StorageRepository` は `MEDIA_STORAGE` に委譲し、既存の Nest provider 名を維持する。
- **`BaseService` / `StorageCore` への影響**
  - `BASE_SERVICE_DEPENDENCIES` などは原則変更せず、`StorageRepository` の実装差し替えのみで backend を切り替えられる構成にする。

## マイグレーション戦略（オプション）

- **初期スコープ**
  - まずは「新規アップロード / 新規生成ファイル」を S3 に保存できることをゴールとし、既存ローカルファイルの自動移行は初期スコープ外とする。
- **将来の移行機能**
  - 既存のストレージテンプレート／ファイルマイグレーションジョブ (`StorageTemplateMigration`, `AssetFileMigration` など) を参考に、Local ↔ S3 の移行ジョブを追加できる余地を残す。
  - マイグレーション時は DB の論理パスを変更せず、実体のみを移し backend 切替で解釈先を変える方式を想定する。

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

### To-dos

- [ ] `StorageRepository` 利用箇所を洗い出し、`IMediaStorageBackend` と Local 実装のメソッドセットを確定する
- [ ] S3 backend 用の環境変数・設定スキーマを `server/src/config.ts` に追加し、`IMMICH_STORAGE_BACKEND` で backend を選択できるようにする
- [ ] 既存 `StorageRepository` のメディア関連メソッドを `LocalStorageBackend` として切り出し、`StorageRepository` から委譲するように書き換える
- [ ] `CloudStorageBackend` を実装し、`S3Client` 経由で主要メソッド（read/write/stat/rename/copy/unlink）をカバーする
- [ ] NestJS の DI で `IMMICH_STORAGE_BACKEND` に応じて Local/S3 backend をバインドし、既存サービス層は `StorageRepository` を参照する構成にする
- [ ] `storage.repository.spec.ts` などのテストを backend 抽象に合わせて更新し、S3 backend 用モックテストとドキュメントを追加する
