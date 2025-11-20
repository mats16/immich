<!-- e5b0eb24-997f-4544-aeb3-6b3dd50d5568 ecdd874a-57cb-4f0e-917e-f0bf79155d8e -->
# StorageRepository を拡張して S3 などのオブジェクトストレージをサポートする改修方針

## 全体方針

- **目的**: 既存の `StorageRepository` / `StorageCore` を活かしつつ、環境変数で選択可能なストレージ backend (default: local, 追加: S3) を導入し、全ての Immich 管理ファイル（オリジナル・サムネイル・エンコード動画・サイドカー等）を S3 に保存できるようにする。
- **基本思想**:
- 「どこに置くか」（Local/S3）と「どんなパス構造にするか」（`StorageCore` のパス設計）を分離する。
- DB に保存されているパス文字列は、**論理パス (= StorageCore が組み立てるパス)** とし、Local backend ではそのままファイルパス、S3 backend ではバケット内のオブジェクトキーとして解釈する。
- ライブラリスキャンや `watch` 等、「ローカルファイルシステム前提の機能」は、S3 backend 選択時でも **ローカル FS のまま** 利用し、Immich が管理するメディア保存先のみを S3 に切り替える。

## 設計変更の概要

- **ストレージ backend の抽象化**
- `StorageRepository` を「ローカル FS ユーティリティ + メディア保存抽象」の 2 層に分けて考える。
- 新しいインターフェース例: `IMediaStorageBackend` を定義し、Immich が管理する全てのメディアファイル操作をこのインターフェース経由で行う。
- 例: `readFile(path)`, `writeFile(path, buffer)`, `createReadStream(path)`, `createWriteStream(path)`, `stat(path)`, `rename(oldPath, newPath)`, `copyFile(oldPath, newPath)`, `unlink(path)` など、`StorageCore`・`StorageTemplateService` 等で実際に呼ばれるメソッドに絞る。
- `StorageRepository` 自体は Nest の provider 名を維持しつつ、内部で `IMediaStorageBackend` 実装に委譲する形に変更するか、もしくは `StorageRepository` をそのまま backend 実装 (local) とし、`MEDIA_STORAGE` のような DI トークンを新設して抽象化する。
- **backend 実装クラス**
- `LocalStorageBackend` (現状の `node:fs/promises` ベースの実装を抽出)
- `CloudStorageBackend` (`@aws-sdk/client-s3` 等を利用し、S3 バケットを利用する実装)
- **ローカル FS 用ユーティリティの扱い**
- `crawl`, `walk`, `watch`, `checkDiskUsage`, `mkdirSync`, `existsSync`, `removeEmptyDirs` など、ホストのファイルシステムを前提とするメソッドは、S3 backend 選択時も **ローカル FS に対して動くユーティリティ**としてそのまま維持する。
- これらは「ライブラリインポート元」や「一時ファイル」など、Immich のメディア保存先とは別レイヤーとみなす。

## 環境変数・設定周りの設計

- **新しい環境変数 (例)**
- `IMMICH_STORAGE_BACKEND`:
- `local` | `s3` を許容、デフォルトは `local`。
- S3 用設定 (必要に応じて):
- `IMMICH_S3_ENDPOINT` (任意 / MinIO 等を想定)
- `IMMICH_S3_REGION`
- `IMMICH_S3_BUCKET`
- `IMMICH_S3_ACCESS_KEY`, `IMMICH_S3_SECRET_KEY`
- `IMMICH_S3_FORCE_PATH_STYLE` (MinIO 等用の boolean) など
- **`server/src/config.ts` への反映**
- 上記環境変数を読み込む設定スキーマを追加し、型 (`SystemConfig` 相当) にもフィールドを追加する。
- 既存の `storageTemplate` や `mediaLocation` 設定との関係を整理し、S3 backend 使用時は `mediaLocation` を「論理プレフィックス」として扱う方針をドキュメント化する。

## StorageRepository / StorageCore まわりの改修

- **`StorageRepository` の役割整理とインターフェース化**  (`server/src/repositories/storage.repository.ts`)
- 既存メソッドを利用用途ごとに分類:
- a) Immich 管理メディアへのアクセスに使われるメソッド（`createReadStream`, `createFile`, `createWriteStream`, `createOrOverwriteFile`, `overwriteFile`, `rename`, `copyFile`, `stat`, `utimes`, `unlink` 等）。
- b) ライブラリスキャン・ユーティリティ用途のメソッド（`crawl`, `walk`, `watch`, `checkDiskUsage`, `mkdirSync`, `existsSync`, `removeEmptyDirs`, `readdir`, `realpath` 等）。
- a) を `IMediaStorageBackend` に切り出し、`StorageRepository` からは `this.backend` 経由で呼ぶように書き換える。
- b) は、`StorageRepository` 内に残しつつ常にローカル FS を叩く実装として維持する (backend=local/s3 に依存しない)。
- **`StorageCore` の変更最小化** (`server/src/cores/storage.core.ts`)
- `StorageCore` はこれまで通り「パス構造の計算」と「move ロジック」に集中させる。
- ファイル実体の操作 (`stat`, `rename`, `copyFile`, `unlink`, `utimes`) は、`storageRepository` が内部で選択した backend 実装を通じて行われるようにする。
- S3 backend 選択時は、`StorageCore` が生成するパスをそのまま S3 キーとして扱う（例: `mediaLocation` を `bucket` 内の prefix とみなす）。
- **`StorageTemplateService` など他の利用箇所の確認**
- `StorageTemplateService` (`server/src/services/storage-template.service.ts`) など、パス移動やファイル検証 (`stat`, `checkFileExists`) を行っているサービスで、`StorageRepository` 経由の呼び出しが S3 backend に対応しているかを確認・補正する。

## S3 backend 実装の概要

- **S3 クライアントの初期化**
- `CloudStorageBackend` 内で `S3Client` を生成し、バケット名・リージョン・認証情報を環境変数から読み込む。
- Nest の DI コンテナで S3 クライアント用プロバイダを作成するか、単純な `new S3Client(...)` を backend クラス内で行うかは規模に応じて選択（初期はシンプルに実装し、必要なら切り出し）。
- **主要メソッドの実装方針**
- `createReadStream(path)`:
- S3 の `GetObjectCommand` を発行し、Body (ReadableStream) を `ImmichReadStream` にマッピング。
- `ContentLength`, `ContentType` を length/type として設定できるようにする（ただしパフォーマンスと簡潔性のバランスを検討）。
- `createWriteStream(path)`:
- Node のストリームから S3 へアップロードする場合、`@aws-sdk/lib-storage` の `Upload` を利用する、もしくは一時ファイルをローカルに書いてから `PutObjectCommand` でアップロードする 2 段階方式を検討する。
- 初期実装は **一時ファイル + バックグラウンドアップロード** よりも、まずは同期アップロード / 単純ストリームで正しさを優先する。
- `createFile` / `createOrOverwriteFile` / `overwriteFile`:
- Buffer をそのまま `PutObjectCommand` の Body に渡す形で実装。
- `stat(path)` / `checkFileExists(path)`:
- `HeadObjectCommand` を利用し、サイズ・更新時刻など必要な最小限のメタ情報を返す。
- `rename(oldPath, newPath)`:
- S3 には rename がないため、`CopyObject` + `DeleteObject` の 2 ステップでエミュレート。
- 既存コードの `EXDEV` フォールバックなどと整合性を取るため、S3 backend では最初から「copy + verify + delete」的な挙動を実装する方針。
- `copyFile(oldPath, newPath)`:
- `CopyObjectCommand` を利用。
- `unlink(path)`:
- `DeleteObjectCommand` を利用。
- **パスとキーのマッピング**
- 既存の `StorageCore` によるパス (例: `/data/library/<user>/<year>/...`) を、そのまま S3 オブジェクトキーとして利用。
- `mediaLocation` を prefix として扱う場合、`/` 始まりをトリムし `mediaLocation` + 相対パス形式に変換するユーティリティを backend 内に実装する。

## DI 構成とバックエンド切替

- **NestJS の provider 構成**
- 例: `MEDIA_STORAGE` という InjectionToken を作り、`providers` で runtime にどのクラスを提供するかを切り替える。
- `IMMICH_STORAGE_BACKEND` が `local` の場合は `LocalStorageBackend`、`s3` の場合は `CloudStorageBackend` をバインド。
- `StorageRepository` はこの `MEDIA_STORAGE` を受け取り、メディア関連メソッドを委譲する。
- **`BaseService` / `StorageCore` への影響**
- `BaseService` の DI リスト (`BASE_SERVICE_DEPENDENCIES`) は基本的に変更不要で、`StorageRepository` の実装差し替えのみで backend を切り替えられるようにする。
- これにより、既存サービス層の変更は最小限に留める。

## マイグレーション戦略（オプション）

- **初期スコープ**
- まずは「新規アップロード / 新規生成ファイル」が S3 に保存されることを目標とし、既存ローカルファイルの自動移行はスコープ外としてよい。
- **将来の移行機能**
- 既存のストレージテンプレート・ファイルマイグレーション用ジョブ (`StorageTemplateMigration`, `AssetFileMigration` など) を参考に、"Local → S3" / "S3 → Local" の移行ジョブを追加実装できる余地を残す。
- マイグレーションの際は、DB 上のパスは変更せず、実体のみを Local ↔ S3 間で移動し、backend の切替により解釈先を変える方式とする。

## テスト・検証方針

- **ユニットテスト**
- `StorageRepository` の spec (`server/src/repositories/storage.repository.spec.ts`) を整理し、backend 抽象に応じたテストへ書き換える。
- `LocalStorageBackend` 用テスト: 既存の挙動と互換性があることを確認。
- `CloudStorageBackend` 用テスト: S3 クライアントをモックし、主要メソッドが正しい AWS コマンドを呼び出すかを検証。
- **統合テスト / 手動検証**
- `IMMICH_STORAGE_BACKEND=local` で現行動作が維持されることを確認（リグレッション防止）。
- `IMMICH_STORAGE_BACKEND=s3` にして、実際の S3 / MinIO を用いた E2E 検証（アップロード／ダウンロード／サムネ生成／ライブフォトなど代表ケース）。

## ドキュメンテーション

- **`docs` ディレクトリへの追記**
- 新しい環境変数とその意味、S3 backend の前提条件（バケット作成、権限設定、S3 互換ストレージの注意点）を記載。
- Local / S3 切替時の制限事項（例: 既存ローカルファイルの自動移行は別途ジョブが必要、`watch` 機能はローカル FS のみ等）を明文化する。

### To-dos

- [ ] StorageRepository の利用箇所を洗い出し、IMediaStorageBackend インターフェースと Local 実装の具体的なメソッドセットを決める
- [ ] S3 backend 用の環境変数・設定スキーマを server/src/config.ts に追加し、IMMICH_STORAGE_BACKEND で backend を選択できるようにする
- [ ] 既存 StorageRepository のメディア関連メソッドを LocalStorageBackend として切り出し、StorageRepository から委譲するように書き換える
- [ ] CloudStorageBackend を実装し、S3Client 経由で主要メソッド（read/write/stat/rename/copy/unlink）を実装する
- [ ] NestJS の DI で IMMICH_STORAGE_BACKEND に応じて Local/S3 backend をバインドし、既存サービス層は StorageRepository のみを見る構成にする
- [ ] storage.repository.spec.ts 等のテストを backend 抽象に合わせて更新し、S3 backend 用のモックテストとドキュメントを追加する