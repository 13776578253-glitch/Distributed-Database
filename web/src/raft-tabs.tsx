/** Section tabs shared by the Raft cluster, live timeline and experiment views. */
const tabs = [
  { target: 'cluster-heading', label: '集群', key: 'cluster' },
  { target: '/timeline', label: '实时事件', key: 'timeline' },
  { target: '/runs', label: '实验回放', key: 'runs' },
] as const;

export function RaftTabs({ active }: { active: (typeof tabs)[number]['key'] }) {
  return <nav className="raft-tabs" aria-label="Raft 视图">
    {tabs.map(tab => <a key={tab.key} href={`#${tab.target}`}
      aria-current={tab.key === active ? 'page' : undefined}>{tab.label}</a>)}
  </nav>;
}
