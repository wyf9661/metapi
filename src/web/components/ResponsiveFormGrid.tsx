import React from 'react';

type ResponsiveFormGridProps = {
  columns?: 1 | 2 | 3;
  children: React.ReactNode;
  className?: string;
};

export default function ResponsiveFormGrid({
  columns = 2,
  children,
  className,
}: ResponsiveFormGridProps) {
  const classes = [
    'responsive-form-grid',
    `responsive-form-grid-${columns}`,
    className,
  ].filter(Boolean).join(' ');

  return <div className={classes}>{children}</div>;
}
