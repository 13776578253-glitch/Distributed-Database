/** Small line icons shared by navigation and cluster panels. */
const paths = {
  overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  reachability: 'M2 12h4l3-7 5 14 3-7h5',
  leader: 'm3 6 5 4 4-6 4 6 5-4-2 12H5L3 6Z',
  term: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  topology: 'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4m-6 4v-4h12v4',
  detail: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 6h6m-6 4h6m-6 4h4',
};

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
