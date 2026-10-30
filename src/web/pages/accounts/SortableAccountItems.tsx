import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { tr } from '../../i18n.js';

/**
 * 列表拖拽排序：与「站点管理」保持一致的交互 —— 整行/整卡就是拖拽面，没有独立把手。
 * listeners 落在 <tr>/<div> 自身，靠 sensor 的 activationConstraint（鼠标 6px 位移、
 * 触屏 180ms 长按）把「拖动排序」和「点击行内的按钮」区分开。
 */
export function SortableAccountTableRow({
  id,
  label,
  disabled,
  className,
  dataTestId,
  isDropTarget,
  rowRef,
  children,
}: {
  id: number;
  label?: string | null;
  disabled: boolean;
  className: string;
  dataTestId?: string;
  isDropTarget?: boolean;
  rowRef: (node: HTMLTableRowElement | null) => void;
  children: React.ReactNode;
}) {
  const sortable = useSortable({ id, disabled });
  const translatedTransform = sortable.transform
    ? { ...sortable.transform, scaleX: 1, scaleY: 1 }
    : null;

  return (
      <tr
        ref={(node) => {
          sortable.setNodeRef(node);
          rowRef(node);
        }}
        // 不用 {...sortable.attributes}：那会带上 role="button"，把 <tr> 变成按钮、
        // 破坏表格语义。键盘拖拽只需要 listeners + 可聚焦元素。
        {...sortable.listeners}
        tabIndex={disabled ? undefined : 0}
        aria-roledescription={disabled ? undefined : tr('可拖拽排序的连接行')}
        aria-describedby={sortable.attributes['aria-describedby']}
        aria-label={disabled || !label ? undefined : `拖拽调整「${label}」的顺序`}
        data-testid={dataTestId}
        className={`${className} ${sortable.isDragging ? 'site-sort-dragging' : ''} ${
          !disabled ? 'site-row-draggable' : ''
        } ${isDropTarget ? 'site-sort-drop-before' : ''}`.trim()}
        style={{
          transform: CSS.Translate.toString(translatedTransform),
          transition: sortable.isDragging ? undefined : (sortable.transition || undefined),
          position: 'relative',
          zIndex: sortable.isDragging ? 3 : undefined,
        }}
      >
        {children}
      </tr>
  );
}

export function SortableAccountMobileCard({
  id,
  label,
  disabled,
  isDropTarget,
  children,
}: {
  id: number;
  label?: string | null;
  disabled: boolean;
  isDropTarget?: boolean;
  children: React.ReactNode;
}) {
  const sortable = useSortable({ id, disabled });
  return (
      <div
        ref={sortable.setNodeRef}
        {...sortable.listeners}
        tabIndex={disabled ? undefined : 0}
        aria-roledescription={disabled ? undefined : tr('可拖拽排序的连接卡片')}
        aria-describedby={sortable.attributes['aria-describedby']}
        aria-label={disabled || !label ? undefined : `拖拽调整「${label}」的顺序`}
        className={`${sortable.isDragging ? 'site-sort-dragging' : ''} ${
          !disabled ? 'site-card-draggable' : ''
        } ${isDropTarget ? 'site-sort-drop-before' : ''}`.trim()}
        style={{
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.isDragging ? undefined : (sortable.transition || undefined),
          position: 'relative',
          zIndex: sortable.isDragging ? 3 : undefined,
        }}
      >
        {children}
      </div>
  );
}
