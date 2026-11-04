// The window's live copy of the house: engine status, devices, plan and rules, kept current by the coordinator's events.
import { useCallback, useEffect, useState } from 'react'
import type { FlowStep, HomeEngineStatus, HomePlan, HomeSnapshot } from '../../../shared/home'
import type { HomeRulesView } from '../../../shared/types'
import { onConnected, onEvent, request } from '../lib/coordinator'

export interface HomeState {
  engine: HomeEngineStatus | null
  snapshot: HomeSnapshot
  plan: HomePlan | null
  rules: HomeRulesView
  /** A step an agent started that needs this window (a QR to scan, a page to open). */
  agentFlow: FlowStep | null
}

const EMPTY: HomeState = {
  engine: null,
  snapshot: { things: [], areas: [], scenes: [], automations: [] },
  plan: null,
  rules: { automations: [], judgment: [], watches: [] },
  agentFlow: null
}

export function useHome(enabled: boolean): HomeState & { reload(): void; clearAgentFlow(): void } {
  const [state, setState] = useState<HomeState>(EMPTY)

  const reload = useCallback(() => {
    if (!enabled) return
    void Promise.all([
      request<HomeEngineStatus>({ method: 'home.status' }),
      request<HomeSnapshot>({ method: 'home.snapshot' }),
      request<HomePlan>({ method: 'home.plan.get' }),
      request<HomeRulesView>({ method: 'home.rules' })
    ])
      .then(([engine, snapshot, plan, rules]) => setState((s) => ({ ...s, engine, snapshot, plan, rules })))
      .catch(() => undefined)
  }, [enabled])

  useEffect(() => {
    if (!enabled) return setState(EMPTY)
    reload()
    const offConnected = onConnected(reload)
    const off = onEvent((event) => {
      if (event.type === 'home.engine') setState((s) => ({ ...s, engine: event.status }))
      else if (event.type === 'home.snapshot') setState((s) => ({ ...s, snapshot: event.snapshot }))
      else if (event.type === 'home.plan') setState((s) => ({ ...s, plan: event.plan }))
      else if (event.type === 'home.rules') setState((s) => ({ ...s, rules: event.rules }))
      else if (event.type === 'home.flow') setState((s) => ({ ...s, agentFlow: event.step }))
    })
    return () => {
      off()
      offConnected()
    }
  }, [enabled, reload])

  return { ...state, reload, clearAgentFlow: () => setState((s) => ({ ...s, agentFlow: null })) }
}
