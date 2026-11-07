/**
 * Bootstrap voters and provisioned node IDs. Order defines host
 * port mapping in scripts and must stay aligned with compose.yaml services.
 */
export const nodeIds = ['raft-1', 'raft-2', 'raft-3', 'raft-4', 'raft-5'];
export const standbyId = 'raft-6';
export const membershipLab = process.env.RAFT_MEMBERSHIP === '1';
export const labNodeIds = membershipLab ? [...nodeIds, standbyId] : nodeIds;
