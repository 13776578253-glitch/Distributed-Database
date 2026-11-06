/** Provides keyboard-accessible in-page navigation in a modal side drawer. */
import { useRef } from 'react';

export function Navigation() {
  const drawer = useRef<HTMLDialogElement>(null);
  const close = () => drawer.current?.close();

  return <>
    <header className="topbar">
      <div className="topbar-content">
        <button type="button" className="nav-button" aria-label="打开导航" aria-haspopup="dialog"
          aria-controls="console-nav" onClick={() => drawer.current?.showModal()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="brand">Distributed Database</span>
      </div>
    </header>
    <dialog id="console-nav" className="drawer" aria-labelledby="nav-title" ref={drawer}
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="drawer-content">
        <div className="drawer-heading">
          <div><h2 id="nav-title">Distributed Database</h2><p>Raft 观测控制台</p></div>
          <button type="button" className="nav-button" aria-label="关闭导航" onClick={close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <nav aria-label="控制台导航" className="drawer-links">
          <a href="#cluster-heading" aria-current="page" onClick={close}><strong>总览</strong><small>集群采样与 Leader</small></a>
          <a href="#topology-heading" onClick={close}><strong>节点拓扑</strong><small>成员角色与通信</small></a>
          <a href="#detail-heading" onClick={close}><strong>节点详情</strong><small>状态、日志进度与应答</small></a>
        </nav>
      </div>
    </dialog>
  </>;
}
