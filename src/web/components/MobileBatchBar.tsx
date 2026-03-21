import React from 'react';

type MobileBatchBarProps = {
  info: React.ReactNode;
  children: React.ReactNode;
};

export default function MobileBatchBar({ info, children }: MobileBatchBarProps) {
  return (
    <div className="mobile-actions-bar mobile-batch-bar">
      <span className="mobile-actions-info">{info}</span>
      <div className="mobile-actions-row">{children}</div>
    </div>
  );
}
