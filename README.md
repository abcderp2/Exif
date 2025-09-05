# Exif Remover Tool

JPEGおよびPNG画像からExifメタデータを削除するツールです。**Web版**と**コマンドライン版**の2つの使い方を提供しています。

## 🌐 Web版（オンラインツール）

**今すぐブラウザで使用**: https://abcderp2.github.io/Exif/

- ドラッグ&ドロップで簡単操作
- 複数ファイルの一括処理
- インストール不要
- プライバシー保護（サーバーに送信されません）

## 💻 コマンドライン版（開発者向け）

### 機能

- JPEG、PNG画像のExifデータを安全に削除
- 単一ファイルまたは複数ファイルの一括処理
- 元のファイルを保護（新しいファイルとして保存）
- エラーハンドリング機能
- 透明度を持つPNG画像にも対応

### インストール

#### 必要な環境
- Python 3.9以上

#### 依存ライブラリのインストール
```bash
pip install Pillow
```

#### ツールの取得
```bash
git clone https://github.com/abcderp2/Exif.git
cd Exif
```

### 使用方法

#### 基本的な使い方
```bash
# 単一ファイルの処理
python exif_remover.py image.jpg

# 複数ファイルの処理
python exif_remover.py image1.jpg image2.png

# ワイルドカードを使った一括処理
python exif_remover.py *.jpg
python exif_remover.py photos/*.png
```

#### 出力ファイル
処理された画像は元のファイル名に `_no_exif` が追加されたファイル名で保存されます。

例:
- `photo.jpg` → `photo_no_exif.jpg`
- `image.png` → `image_no_exif.png`

## サポートするファイル形式

- **入力**: JPEG (.jpg, .jpeg), PNG (.png)
- **出力**: JPEG, PNG

## 特徴

- **安全性**: 元のファイルは変更されません
- **シンプル**: 軽量で使いやすい設計
- **エラー処理**: ファイルが存在しない場合や権限エラーなどを適切に処理
- **透明度保持**: PNG画像の透明度は保持されます
- **品質保持**: JPEG画像は高品質（95%）で保存されます

## 使用例

### Web版
1. https://abcderp2.github.io/Exif/ にアクセス
2. 画像をドラッグ&ドロップ
3. 処理完了後にダウンロード

### コマンドライン版
```bash
# 写真フォルダ内のすべてのJPEG画像を処理
python exif_remover.py photos/*.jpg

# 特定のファイルを処理
python exif_remover.py vacation_photo.jpg profile_pic.png

# 処理結果の例
# Exifデータを削除しました: vacation_photo_no_exif.jpg
# Exifデータを削除しました: profile_pic_no_exif.png
# 処理完了: 2/2 ファイルが正常に処理されました
```

## エラーハンドリング

このツールは以下のエラーを適切に処理します：

- ファイルが見つからない場合
- サポートされていないファイル形式
- ファイル書き込み権限エラー
- 破損した画像ファイル

## ライセンス

このプロジェクトはMITライセンスの下で公開されています。詳細は [LICENSE](LICENSE) ファイルをご覧ください。

## 貢献

プロジェクトへの貢献を歓迎します。以下の方法で参加できます：

1. このリポジトリをフォーク
2. 新しいブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add some amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを開く

## 問題の報告

バグを発見した場合や機能要望がある場合は、[Issues](https://github.com/abcderp2/Exif/issues) ページで報告してください。

## 免責事項

このツールは画像ファイルを処理しますが、元のファイルは変更しません。ただし、重要なファイルを処理する前にはバックアップを取ることをお勧めします。
