/**
 * Batch-allocation logic for demoting L1 mirror rows into the L2 roadmap
 * backlog. No IO here — the caller reads the real backlog toon and writes the
 * resulting rows/links back through whatever seam it owns.
 */

import * as Schema from 'effect/Schema'

import { MirrorLink, type MirrorRow } from './mirror.ts'

/** Minimal shape needed from an existing L2 backlog entry: its identity. */
export const BacklogEntry = Schema.Struct({ n: Schema.Finite })
export type BacklogEntry = typeof BacklogEntry.Type

/** One row to append to the L2 backlog. */
export const DemoteRow = Schema.Struct({ n: Schema.Finite, item: Schema.String })
export type DemoteRow = typeof DemoteRow.Type

/**
 * Why a mirror row was not demoted.
 *
 * There is no `deleted` reason any more: no harness event reports a deletion,
 * so a deleted task is unobservable and can never reach the mirror.
 */
export const DemoteSkipReason = Schema.Literals(['completed', 'already-linked', 'empty'])
export type DemoteSkipReason = typeof DemoteSkipReason.Type

export const DemoteSkip = Schema.Struct({
	sessionId: Schema.String,
	id: Schema.String,
	reason: DemoteSkipReason,
})
export type DemoteSkip = typeof DemoteSkip.Type

/** The L1 `(sessionId, id)` <-> newly-allocated L2 `n`, for writing back into the mirror. */
export const DemoteLink = MirrorLink
export type DemoteLink = typeof DemoteLink.Type

export const DemotePlan = Schema.Struct({
	rows: Schema.Array(DemoteRow),
	skipped: Schema.Array(DemoteSkip),
	links: Schema.Array(DemoteLink),
})
export type DemotePlan = typeof DemotePlan.Type

/**
 * max(n) + 1 over existing backlog entries. NEVER length + 1: `n` is durable
 * identity across files and the block is sparse (tombstoned gaps), so
 * counting rows would reissue an `n` other files still point at.
 */
export function nextBacklogN(rows: readonly BacklogEntry[]): number {
	let max = 0
	for (const row of rows) {
		if (row.n > max) max = row.n
	}
	return max + 1
}

function buildItem(row: MirrorRow): string {
	const parts = [row.subject.trim(), row.description.trim()].filter(part => part.length > 0)
	return parts.join(' -- ')
}

/**
 * Batch-allocate every backlog `n` in one pass. This is the whole point: the
 * scar it cures is that no batch primitive existed, so a batch had to be faked
 * by pasting raw multi-row TOON into a --set that takes discrete pairs, which
 * corrupted the file.
 *
 * `status !== 'completed'` is the ONLY liveness signal available. With no
 * TaskUpdated/in_progress event to observe, "has not been reported completed"
 * is the entire definition of unfinished — there is no started-but-unfinished
 * distinction to make, and no deletion to detect.
 */
export function planDemote(
	mirror: readonly MirrorRow[],
	backlog: readonly BacklogEntry[],
): DemotePlan {
	const rows: DemoteRow[] = []
	const skipped: DemoteSkip[] = []
	const links: DemoteLink[] = []

	let next = nextBacklogN(backlog)

	for (const row of mirror) {
		if (row.status === 'completed') {
			skipped.push({ sessionId: row.sessionId, id: row.id, reason: 'completed' })
			continue
		}
		if (row.backlogN !== undefined) {
			skipped.push({ sessionId: row.sessionId, id: row.id, reason: 'already-linked' })
			continue
		}

		const item = buildItem(row)
		if (item === '') {
			skipped.push({ sessionId: row.sessionId, id: row.id, reason: 'empty' })
			continue
		}

		const n = next
		next += 1
		rows.push({ n, item })
		links.push({ sessionId: row.sessionId, id: row.id, n })
	}

	return { rows, skipped, links }
}

/**
 * The return leg: which unfinished mirror rows are missing from a task list.
 *
 * ADDITIVE ONLY, and the signature is the enforcement. This returns rows to
 * ADD and has no channel to express a removal, because the tempting inverse —
 * "delete L1 tasks the mirror does not know about" — would wipe the task list
 * on any of several ordinary days:
 *
 *  - the mirror only ever learns what a hook told it, and hooks wire at
 *    session start, so a resumed session records nothing while work continues;
 *  - a cleared `XDG_STATE_HOME`, a fresh machine, or a first run yields an
 *    EMPTY mirror, under which every single L1 task reads as a stray;
 *  - completed rows are pruned from no one's mirror but were never added to
 *    this one either — 14 such rows were absent when this was written.
 *
 * Absence from the mirror is not evidence of absence in reality. A negative
 * claim needs a positive control, and the mirror cannot supply one, so the
 * only safe direction is add.
 */
export function planPromote(
	mirror: readonly MirrorRow[],
	have: ReadonlySet<string>,
): readonly MirrorRow[] {
	return mirror.filter(row => row.status !== 'completed' && !have.has(row.id))
}
