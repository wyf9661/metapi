#!/usr/bin/env python3
"""批量修复 TypeScript 类型错误"""

import subprocess
import re
from pathlib import Path
from collections import defaultdict

def get_typescript_errors():
    """获取所有 TypeScript 错误"""
    result = subprocess.run(
        ['npx', 'tsc', '--noEmit'],
        capture_output=True,
        text=True,
        cwd='/home/ivan/projects/metapi'
    )
    
    errors_by_file = defaultdict(list)
    for line in result.stdout.split('\n'):
        if 'error TS' not in line:
            continue
        # 解析错误信息
        match = re.match(r'([^:]+\.ts):(\d+):\d+: error TS(\d+): (.+)', line)
        if match:
            file_path, line_num, error_code, message = match.groups()
            errors_by_file[file_path].append({
                'line': int(line_num),
                'code': error_code,
                'message': message
            })
    
    return errors_by_file

def fix_implicit_any(content, line_num, param_name):
    """修复隐式 any 类型"""
    lines = content.split('\n')
    if line_num < 1 or line_num > len(lines):
        return content
    
    line_idx = line_num - 1
    line = lines[line_idx]
    original_line = line
    
    # 修复箭头函数参数
    # .map((param) =>
    line = re.sub(
        rf'(\.(?:map|filter|find|some|every|forEach)\(\s*\(\s*){param_name}(\s*\)\s*=>)',
        rf'\1{param_name}: any\2',
        line
    )
    
    # (param) => 在行首或逗号后
    if line == original_line:
        line = re.sub(
            rf'(\(\s*){param_name}(\s*\)\s*=>)',
            rf'\1{param_name}: any\2',
            line
        )
    
    lines[line_idx] = line
    return '\n'.join(lines)

def main():
    print("获取 TypeScript 错误...")
    errors_by_file = get_typescript_errors()
    
    total_errors = sum(len(errs) for errs in errors_by_file.values())
    print(f"找到 {total_errors} 个错误，分布在 {len(errors_by_file)} 个文件中")
    
    fixed_count = 0
    files_modified = []
    
    for file_path, errors in errors_by_file.items():
        # 只处理 TS7006 (implicit any) 错误
        ts7006_errors = [e for e in errors if e['code'] == '7006']
        if not ts7006_errors:
            continue
        
        try:
            content = Path(file_path).read_text()
            modified = False
            
            # 按行号倒序处理，避免行号变化
            for error in sorted(ts7006_errors, key=lambda x: -x['line']):
                param_match = re.search(r"Parameter '(\w+)' implicitly", error['message'])
                if not param_match:
                    continue
                
                param_name = param_match.group(1)
                new_content = fix_implicit_any(content, error['line'], param_name)
                
                if new_content != content:
                    content = new_content
                    modified = True
                    fixed_count += 1
            
            if modified:
                Path(file_path).write_text(content)
                files_modified.append(file_path)
                print(f"✓ 修复 {file_path} ({len(ts7006_errors)} 个错误)")
        
        except Exception as e:
            print(f"✗ 处理 {file_path} 时出错: {e}")
    
    print(f"\n修复完成:")
    print(f"  修复了 {fixed_count} 个错误")
    print(f"  修改了 {len(files_modified)} 个文件")

if __name__ == '__main__':
    main()
