/** Provides keyboard-accessible in-page navigation in a modal side drawer. */
import { useRef } from 'react';
import { Icon } from './icons.tsx';

const connectionLabels = { online: '已连接', offline: '观测离线', connecting: '连接中' };
const links = [
  { target: 'cluster-heading', icon: 'overview', title: '总览', hint: '集群采样与 Leader' },
  { target: 'topology-heading', icon: 'topology', title: '节点拓扑', hint: '成员角色与通信' },
  { target: 'detail-heading', icon: 'detail', title: '节点详情', hint: '状态、日志进度与应答' },
  { target: '/timeline', icon: 'term', title: '实时事件', hint: 'Raft Timeline · SSE' },
  { target: '/runs', icon: 'detail', title: '实验与回放', hint: 'Verification · Evidence' },
  { target: '/settings', icon: 'overview', title: '设置', hint: '服务、日志与外观' },
] as const;

export function Navigation({ connection, view }: { connection: keyof typeof connectionLabels; view: string }) {
  const drawer = useRef<HTMLDialogElement>(null);
  const close = () => drawer.current?.close();
  const page = links.find(item => item.target === view) ?? links[0];

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
