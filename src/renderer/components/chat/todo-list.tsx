import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn.js';
import { Icon } from '../ui/icon.js';
import styles from './TodoList.module.css';

export type TodoItemState = 'pending' | 'active' | 'done';

export interface TodoItem {
  id: string;
  content: ReactNode;
  state?: TodoItemState;
}

/** Controlled task presentation. Progress comes from callers; this component never invents timers. */
export function TodoList({ title = 'To-dos', items, actions }: { title?: string; items: readonly TodoItem[]; actions?: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const completed = items.filter(item => item.state === 'done').length;
  const active = items.some(item => item.state === 'active');
  const allDone = items.length > 0 && completed === items.length;

  return (
    <div className={styles.todo}>
      <div className={styles.headRow}>
        <button type="button" className={styles.todoHead} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
          <span className={styles.headIcon}>
            {allDone ? <Icon name="i-check" className={styles.check} /> : active ? <span className={styles.progressDot} /> : <Icon name="i-steps" />}
          </span>
          <span className={styles.title}>{title}</span>
          <span className={styles.count}>{completed}/{items.length}</span>
          <Icon name="i-down" className={cn(styles.chevron, collapsed && styles.collapsedChevron)} />
        </button>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      <div className={cn(styles.collapsible, collapsed && styles.collapsed)}>
        <div className={styles.inner}>
          <ul className={styles.list}>
            {items.map((item) => {
              const state = item.state ?? 'pending';
              return (
                <li key={item.id} className={cn(styles.item, styles[state])}>
                  <span className={styles.iconWrap} aria-hidden="true">
                    {state === 'done' ? <Icon name="i-check" /> : state === 'active' ? <Icon name="i-chev" /> : <span className={styles.pendingRing} />}
                  </span>
                  <div className={styles.label}>{item.content}</div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
