import { ReactNode } from 'react';

/** Multi-state rendering without nested ternaries: the FIRST case whose condition is truthy wins (lazy). */
export function choose(cases: Array<[unknown, () => ReactNode]>, otherwise: () => ReactNode): ReactNode {
  const hit = cases.find(([cond]) => !!cond);
  return hit ? hit[1]() : otherwise();
}
