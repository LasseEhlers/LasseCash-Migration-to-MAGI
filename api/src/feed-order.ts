/**
 * Where a post belongs on Trending. Presentation only: the figures it reads
 * were reported by the chain, and nothing here changes one.
 *
 * Trending is a ranking by what can still earn, so a paid-out post, which never
 * can again, sits below a tagged post that a first vote could still register.
 * Paid-out posts leave Trending OLDER_AFTER_DAYS after their window closed, and
 * "Show older posts" brings them back. They stay on New, on profiles and at
 * their own URLs.
 *
 * Counted from the window closing, not from the payout: settling can happen
 * late, and a post nobody settled for a month must not get a fresh two weeks.
 */
export const OLDER_AFTER_DAYS = 14;

/** Heights advance every 3 seconds. */
const HEIGHTS_PER_DAY = 28_800;

/** 0 = can earn or awaits settling, 1 = unregistered, 2 = paid out. */
export function trendingTier(registered: boolean, paidOut: boolean | undefined): 0 | 1 | 2 {
  if (paidOut) return 2;
  return registered ? 0 : 1;
}

export function isOlderPaidOut(
  post: { paid_out: boolean; payout_height: number } | undefined,
  height: number,
): boolean {
  if (!post?.paid_out || height <= 0 || post.payout_height <= 0) return false;
  return height >= post.payout_height + OLDER_AFTER_DAYS * HEIGHTS_PER_DAY;
}
