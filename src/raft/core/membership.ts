/** Defines voter eligibility and the common joint-consensus quorum predicate. */
import type { Configuration } from './types.ts';

export function isVoter(configuration: Configuration, id: string): boolean {
  return configuration.voters.includes(id) || configuration.next?.includes(id) === true;
}

/** 联合阶段各算各的多数，重叠成员的一份应答可计入两组。 */
export function hasQuorum(configuration: Configuration, acknowledged: (id: string) => boolean): boolean {
  const majority = (voters: readonly string[]) =>
    voters.filter(acknowledged).length > Math.floor(voters.length / 2);
  return majority(configuration.voters) && (!configuration.next || majority(configuration.next));
}
