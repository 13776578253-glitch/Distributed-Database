/** Provides keyboard-accessible in-page navigation in a modal side drawer. */
import { useRef } from 'react';
import { Icon } from './icons.tsx';

const connectionLabels = { online: '已连接', offline: '观测离线', connecting: '连接中' };
const raftViews = new Set(['', 'cluster-heading', '/timeline', '/runs']);
const links = [
  { target: 'cluster-heading', icon: 'topology', title: 'Raft', hint: '集群、实时事件与实验回放',
    match: (view: string) => raftViews.has(view) },
  { target: '/transaction', icon: 'detail', title: '事务', hint: 'MVCC / WAL 与恢复' },
  { target: '/verification', icon: 'detail', title: '一致性验证', hint: '判定与反例' },
  { target: '/settings', icon: 'overview', title: '设置', hint: '服务、日志与外观' },
] as const;

export function Navigation({ connection, view }: { connection: keyof typeof connectionLabels; view: string }) {
  const drawer = useRef<HTMLDialogElement>(null);
  const close = () => drawer.current?.close();
  const page = links.find(item => ('match' in item ? item.match(view) : item.target === view)) ?? links[0];

  return <>
    <header className="topbar">
      <div className="topbar-content">
        <button type="button" className="nav-button" aria-label="打开导航" aria-haspopup="dialog"
          aria-controls="console-nav" onClick={() => drawer.current?.showModal()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="toolbar-label"><Icon name={page.icon} /><strong>{page.title}</strong><span>{page.hint}</span></div>
        <span className={`connection ${connection}`} role="status">
          <span className="dot" />{connectionLabels[connection]}
        </span>
      </div>
    </header>
    <dialog id="console-nav" className="drawer" aria-labelledby="nav-title" ref={drawer}
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="drawer-content">
        <div className="drawer-heading">
          <div className="drawer-brand">
            <span className="drawer-mark"><Icon name="topology" /></span>
            <div><h2 id="nav-title">Distributed Database</h2><p>Raft 观测控制台</p></div>
          </div>
          <button type="button" className="nav-button" aria-label="关闭导航" onClick={close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <nav aria-label="控制台导航" className="drawer-links">
          {links.map(({ target, icon, title, hint }) =>
            <a key={target} href={`#${target}`} aria-current={target === page.target ? 'page' : undefined} onClick={close}>
              <Icon name={icon} /><span><strong>{title}</strong><small>{hint}</small></span>
            </a>)}
        </nav>
      </div>
    </dialog>
  </>;
}
