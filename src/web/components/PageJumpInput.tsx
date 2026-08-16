import { useState } from 'react';

type PageJumpInputProps = {
  totalPages: number;
  onJump: (page: number) => void;
};

/** 分页跳转输入框：输入页码 + 回车/点按钮跳到任意页。 */
export default function PageJumpInput({ totalPages, onJump }: PageJumpInputProps) {
  const [value, setValue] = useState('');

  const handleInput = (raw: string) => {
    if (raw === '') {
      setValue('');
      return;
    }
    const parsed = parseInt(raw, 10) || 1;
    setValue(String(Math.min(Math.max(1, parsed), totalPages)));
  };

  const jump = () => {
    if (!value) return;
    onJump(parseInt(value, 10));
    setValue('');
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
      <input
        type="number"
        min={1}
        max={totalPages}
        value={value}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') jump();
        }}
        style={{
          width: 48,
          height: 28,
          padding: '0 6px',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 12,
          textAlign: 'center',
          background: 'var(--color-bg)',
          color: 'var(--color-text-primary)',
          outline: 'none',
          appearance: 'textfield',
          MozAppearance: 'textfield',
        }}
      />
      <button
        type="button"
        className="pagination-btn"
        disabled={!value}
        onClick={jump}
        style={{ height: 28, fontSize: 12, padding: '0 8px', minWidth: 'auto' }}
      >
        跳转
      </button>
    </span>
  );
}