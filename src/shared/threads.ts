/** A thread whose agent sits in a company. Those open from Empresas, never from the Chat tab or the phone. */
export function isCompanyThread(agentId: string, agents: readonly { id: string; companyId?: string }[]): boolean {
  return agents.some((agent) => agent.id === agentId && Boolean(agent.companyId))
}

/** What the Chat tab lists: every thread except the company ones, in the order given. */
export function listableThreads<T extends { agentId: string }>(rows: readonly T[], agents: readonly { id: string; companyId?: string }[]): T[] {
  return rows.filter((row) => !isCompanyThread(row.agentId, agents))
}
