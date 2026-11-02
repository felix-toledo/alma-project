import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { monthKey } from '../../shared/company'
import type { CompanyActivity, CompanySpend, CompanyTask, Meeting } from '../../shared/types'

interface CompanyData {
  tasks: CompanyTask[]
  meetings: Meeting[]
  activity: CompanyActivity[]
  /** One entry per month. */
  spend: CompanySpend[]
  /** Budget warnings already sent ("2026-10:company", "2026-10:member-x"), so each goes out once a month. */
  warned: string[]
}

const ACTIVITY_LIMIT = 300
const empty = (): CompanyData => ({ tasks: [], meetings: [], activity: [], spend: [], warned: [] })

/** Each company's board, meetings, activity and spend, one JSON file per company next to the threads. */
export class CompanyStore {
  private dir: string
  private cache = new Map<string, CompanyData>()

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'companies')
    mkdirSync(this.dir, { recursive: true })
  }

  data(companyId: string): CompanyData {
    let data = this.cache.get(companyId)
    if (!data) {
      const file = join(this.dir, `${companyId}.json`)
      try {
        data = existsSync(file) ? { ...empty(), ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<CompanyData>) } : empty()
      } catch {
        data = empty()
      }
      // Nothing survives a restart mid-run: work in progress goes back to the queue, a live meeting is closed.
      for (const task of data.tasks) if (task.status === 'in_progress') task.status = 'todo'
      for (const meeting of data.meetings) if (meeting.status === 'live' || meeting.status === 'preparing') meeting.status = 'scheduled'
      this.cache.set(companyId, data)
    }
    return data
  }

  save(companyId: string): void {
    const data = this.data(companyId)
    const file = join(this.dir, `${companyId}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1), 'utf8')
    renameSync(`${file}.tmp`, file)
  }

  log(companyId: string, entry: Omit<CompanyActivity, 'at'>): void {
    const data = this.data(companyId)
    data.activity.push({ ...entry, at: Date.now() })
    if (data.activity.length > ACTIVITY_LIMIT) data.activity.splice(0, data.activity.length - ACTIVITY_LIMIT)
  }

  spend(companyId: string, month = monthKey()): CompanySpend {
    const data = this.data(companyId)
    let entry = data.spend.find((s) => s.month === month)
    if (!entry) {
      entry = { month, totalUsd: 0, byMember: {} }
      data.spend.push(entry)
    }
    return entry
  }

  addSpend(companyId: string, memberId: string, usd: number): CompanySpend {
    const entry = this.spend(companyId)
    entry.totalUsd += usd
    entry.byMember[memberId] = (entry.byMember[memberId] ?? 0) + usd
    return entry
  }
}
