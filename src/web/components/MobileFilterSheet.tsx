import React from 'react';
import MobileDrawer from './MobileDrawer.js';

type MobileFilterSheetProps = {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
};

export default function MobileFilterSheet({
  open,
  onClose,
  title = '筛选',
  children,
}: MobileFilterSheetProps) {
  return (
    <MobileDrawer open={open} onClose={onClose} title={title} closeLabel="关闭筛选">
      <div className="mobile-filter-panel">
        {children}
      </div>
    </MobileDrawer>
  );
}
