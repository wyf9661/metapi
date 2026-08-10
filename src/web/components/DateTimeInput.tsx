interface DateTimeInputProps {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  label?: string;
}

/**
 * 包装 datetime-local 输入框。
 *
 * 原生 <input type="datetime-local"> 的占位文字由浏览器根据系统语言渲染，
 * 在中文系统上会出现 "yyyy/mm/dd --:--" 这种中英文混合、难以阅读的文字，
 * 且无法通过 HTML/CSS/JS 修改。
 *
 * 本组件在值为空时叠加一个自定义占位层，让占位文字完全可控、中英文界面统一。
 */
export default function DateTimeInput({
  value,
  onChange,
  min,
  max,
  placeholder = '选择日期时间',
  label,
}: DateTimeInputProps) {
  return (
    <span className="dt-input-wrapper">
      {label && <span className="dt-input-label">{label}</span>}
      <span className="dt-input-box">
        <input
          type="datetime-local"
          value={value}
          min={min}
          max={max}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label || placeholder}
          className={!value ? 'dt-empty' : undefined}
        />
        {!value && (
          <span className="dt-input-placeholder" aria-hidden="true">
            {placeholder}
          </span>
        )}
      </span>
    </span>
  );
}
