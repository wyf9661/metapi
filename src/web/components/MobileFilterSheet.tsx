import React from 'react';
import MobileDrawer from './MobileDrawer.js';
import { tr } from '../i18n.js';

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
    <MobileDrawer open={open} onClose={onClose} title={title} closeLabel={tr('关闭筛选')}>
      <div className="mobile-filter-panel">
        {children}
      </div>
    </MobileDrawer>
  );
}
