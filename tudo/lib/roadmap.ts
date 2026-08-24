/**
 * Reading the L2 side: extract the existing backlog identities from a roadmap
 * TOON so `nextBacklogN` can allocate above them.
 *
 * Only `n` is parsed, never `item`. Allocation is the sole reason this module
 * exists, and `n` is the only field it needs — parsing the item text as well
 * would mean re-implementing TOON quoting rules for a value nothing reads.
 */

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { BacklogEntry } from './demote.ts'

/** The roadmap text did not contain a usable backlog block. */
export class RoadmapParseError extends Schema.TaggedError<RoadmapParseError>()(
	'RoadmapParseError',
	{ reason: Schema.String },
) {}

/**
 * Header of the tabular block, e.g. `backlog[74]{n,item}:` or `backlog[98:]{item}:`.
 * The declared row count is deliberately NOT trusted as the source of truth — it is a header
 * the writer maintains, and the rows themselves are what allocation must not
 * collide with. It is read back only to report a mismatch.
 */
const HEADER = /^backlog\[(\d+)(?::)?\]\{[^}]+\}:\s*$/

/** A row line: two-space indent, then the integer identity before comma or colon (quoted or not). */
const ROW = /^ {2}"?(\d+)"?\s*[:,]/

/**
 * Parse the `backlog` block's identities out of roadmap TOON text.
 *
 * Fails loudly when the block is missing rather than returning `[]`: an empty
 * list would make `nextBacklogN` allocate `1`, silently reissuing identities
 * that other files still point at. A roadmap we could not read must never look
 * like a roadmap with nothing in it.
 */
export const parseBacklogEntries = (
	text: string,
): Effect.Effect<readonly BacklogEntry[], RoadmapParseError> =>
	Effect.gen(function* () {
		const lines = text.split('\n')
		const headerAt = lines.findIndex(line => HEADER.test(line))
		if (headerAt === -1) {
			return yield* Effect.fail(
				new RoadmapParseError({ reason: 'no `backlog[N]{n,item}:` block found' }),
			)
		}

		const rows: BacklogEntry[] = []
		for (const line of lines.slice(headerAt + 1)) {
			const match = ROW.exec(line)
			// The block ends at the first line that is not one of its rows — the
			// next block header, or end of file.
			if (match === null) break
			rows.push({ n: Number(match[1]) })
		}

		if (rows.length === 0) {
			return yield* Effect.fail(
				new RoadmapParseError({ reason: 'backlog block declared but has no rows' }),
			)
		}

		return rows
	})

/**
 * The row count the block header claims, when it disagrees with the rows that
 * follow it. `Option`-free on purpose: callers want a warning string or
 * nothing, and there is exactly one shape of warning.
 */
export const backlogCountMismatch = (
	text: string,
	parsed: number,
): Effect.Effect<string | undefined> =>
	Effect.sync(() => {
		for (const line of text.split('\n')) {
			const match = HEADER.exec(line)
			if (match === null) continue
			const declared = Number(match[1])
			return declared === parsed
				? undefined
				: `backlog header declares ${declared} rows, parsed ${parsed}`
		}
		return undefined
	})
