#!/usr/bin/env python3
"""
Exif Remover Tool
-----------------
JPEGおよびPNG画像からExifメタデータを除去するシンプルなコマンドラインツール

使用方法:
    python exif_remover.py image.jpg
    python exif_remover.py *.jpg
    python exif_remover.py image1.png image2.jpg

依存ライブラリ:
    Pillow (pip install Pillow)

ライセンス: MIT License
"""

import sys
import glob
import os
from PIL import Image


def remove_exif(input_path, output_path):
    """
    画像からExifデータを除去して新しいファイルに保存する関数
    
    Args:
        input_path (str): 入力画像ファイルのパス
        output_path (str): 出力画像ファイルのパス
    """
    try:
        # 画像ファイルを開く
        with Image.open(input_path) as image:
            # 対応する形式かチェック
            if image.format not in ['JPEG', 'PNG']:
                print(f"警告: {input_path} はサポートされていない形式です ({image.format})")
                return False
            
            # 画像データを取得（Exifなし）
            # RGBに変換してExifデータを確実に除去
            if image.mode in ('RGBA', 'LA', 'P'):
                # 透明度を持つ画像の場合はRGBAで保存
                image_data = image.convert('RGBA')
            else:
                image_data = image.convert('RGB')
            
            # 出力ファイルの拡張子に応じて保存形式を決定
            _, ext = os.path.splitext(output_path)
            
            if ext.lower() in ['.jpg', '.jpeg']:
                # JPEG形式で保存（透明度は保持されない）
                if image_data.mode == 'RGBA':
                    # 白背景で合成
                    rgb_image = Image.new('RGB', image_data.size, (255, 255, 255))
                    rgb_image.paste(image_data, mask=image_data.split()[-1])
                    rgb_image.save(output_path, 'JPEG', quality=95)
                else:
                    image_data.save(output_path, 'JPEG', quality=95)
            elif ext.lower() == '.png':
                # PNG形式で保存（透明度も保持）
                image_data.save(output_path, 'PNG')
            else:
                print(f"警告: サポートされていない出力形式です: {ext}")
                return False
            
            print(f"Exifデータを削除しました: {output_path}")
            return True
            
    except FileNotFoundError:
        print(f"エラー: ファイル '{input_path}' が見つかりません")
        return False
    except PermissionError:
        print(f"エラー: ファイル '{output_path}' への書き込み権限がありません")
        return False
    except Exception as e:
        print(f"エラー: {input_path} の処理中に問題が発生しました: {str(e)}")
        return False


def generate_output_filename(input_path):
    """
    入力ファイル名から出力ファイル名を生成する関数
    例: image.jpg -> image_no_exif.jpg
    
    Args:
        input_path (str): 入力ファイルのパス
        
    Returns:
        str: 出力ファイルのパス
    """
    directory = os.path.dirname(input_path)
    basename = os.path.basename(input_path)
    name, ext = os.path.splitext(basename)
    
    output_filename = f"{name}_no_exif{ext}"
    return os.path.join(directory, output_filename)


def main():
    """
    メイン関数：コマンドライン引数を処理してファイルを変換する
    """
    # 使用方法を表示
    if len(sys.argv) < 2:
        print("使用方法: python exif_remover.py <image_file(s)>")
        print("例:")
        print("  python exif_remover.py image.jpg")
        print("  python exif_remover.py *.jpg")
        print("  python exif_remover.py image1.png image2.jpg")
        sys.exit(1)
    
    # コマンドライン引数からファイルリストを展開
    files = []
    for arg in sys.argv[1:]:
        # ワイルドカード（*）を含む引数を展開
        expanded_files = glob.glob(arg)
        if expanded_files:
            files.extend(expanded_files)
        else:
            # ワイルドカードが展開されない場合はそのまま追加
            files.append(arg)
    
    if not files:
        print("エラー: 処理する画像ファイルが見つかりません")
        sys.exit(1)
    
    # 処理結果の統計
    success_count = 0
    total_count = len(files)
    
    print(f"{total_count}個のファイルを処理開始...")
    print("-" * 50)
    
    # 各ファイルを処理
    for input_path in files:
        # 出力ファイル名を生成
        output_path = generate_output_filename(input_path)
        
        # 出力ファイルが既に存在する場合の確認
        if os.path.exists(output_path):
            print(f"警告: {output_path} は既に存在します。スキップします。")
            continue
        
        # Exif除去処理を実行
        if remove_exif(input_path, output_path):
            success_count += 1
    
    # 処理結果を表示
    print("-" * 50)
    print(f"処理完了: {success_count}/{total_count} ファイルが正常に処理されました")


if __name__ == "__main__":
    main()
