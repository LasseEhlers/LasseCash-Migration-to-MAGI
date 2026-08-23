#!/usr/bin/env python3
"""
Tests for the code that decides who keeps their tokens.

    python3 -m unittest discover -s tools/snapshot -v

WHY THIS EXISTS. Until 2026-08-23 the snapshot pipeline had no tests at all —
five scripts, run once, that read two blockchains and commit their answer to an
immutable Merkle root. Everything found wrong in it so far was found by a human
reading output:

  * `he_authorized_by` fell back to `entry["account"] == account`, which is
    true on EVERY row because `account` is simply whose history was queried.
    Received transfers and third-party stakes counted as the recipient's own
    engagement.
  * `HE_USER_OPS` asked for `tokens_unstake` and `tokens_undelegate`, which do
    not exist. Every powerdown and undelegation since 2019 was invisible.
  * `fetch_balances` resumed from max(_id), so a balance that CHANGED was never
    re-read. It double-counted a gift run into an 81,150 hardcap breach.
  * `fetch_activity` skipped any account it already had a record for, which
    would have made every roll-call action invisible.

Three of those four are in the two functions tested here. They are pure, they
are cheap to test, and they are the ones that decide whether an account is
burned.
"""
import unittest
from datetime import datetime, timedelta, timezone

import apply_criteria as ac
import fetch


def op(**kw):
    """One row as Hive-Engine's accountHistory returns it."""
    base = {"operation": "tokens_transfer", "account": "alice", "symbol": "LASSECASH"}
    base.update(kw)
    return base


class Authorship(unittest.TestCase):
    """fetch.he_authorized_by — did THIS account initiate the operation?"""

    def test_a_transfer_you_sent_counts(self):
        self.assertTrue(fetch.he_authorized_by("alice", op(**{"from": "alice", "to": "bob"})))

    def test_a_transfer_you_received_does_not(self):
        # The bug that mattered: `account` equals the queried account on every
        # row, so a fallback on it made every received transfer count.
        self.assertFalse(fetch.he_authorized_by("alice", op(**{"from": "bob", "to": "alice"})))

    def test_a_stake_someone_else_made_into_your_account_does_not(self):
        # @tibfox's entire recent history is this shape: from=lassecash,
        # to=tibfox, an automated tribe payout he never signed.
        self.assertFalse(fetch.he_authorized_by(
            "tibfox", op(operation="tokens_stake", **{"from": "lassecash", "to": "tibfox"})))

    def test_staking_to_yourself_counts(self):
        self.assertTrue(fetch.he_authorized_by(
            "alice", op(operation="tokens_stake", **{"from": "alice", "to": "alice"})))

    def test_an_unstake_you_started_counts(self):
        # No from/to on these, but only the owner can start their own.
        self.assertTrue(fetch.he_authorized_by("alice", op(operation="tokens_unstakeStart")))
        self.assertTrue(fetch.he_authorized_by("alice", op(operation="tokens_undelegateStart")))

    def test_the_automatic_instalments_never_count(self):
        # A powerdown fires 26 weekly instalments on a timer. If these counted,
        # ONE powerdown would look like six months of an account being alive.
        self.assertFalse(fetch.he_authorized_by("alice", op(operation="tokens_unstakeDone")))
        self.assertFalse(fetch.he_authorized_by("alice", op(operation="tokens_undelegateDone")))

    def test_an_unknown_operation_without_a_sender_fails_closed(self):
        self.assertFalse(fetch.he_authorized_by("alice", op(operation="tokens_somethingNew")))


class RequestedOperations(unittest.TestCase):
    """The server-side filter must name operations that actually exist."""

    def test_the_operation_names_are_the_real_ones(self):
        ops = fetch.HE_USER_OPS.split(",")
        # These two were requested for months and silently matched nothing,
        # hiding every powerdown and undelegation since 2019.
        self.assertNotIn("tokens_unstake", ops)
        self.assertNotIn("tokens_undelegate", ops)
        self.assertIn("tokens_unstakeStart", ops)
        self.assertIn("tokens_undelegateStart", ops)

    def test_the_automatic_completions_are_not_even_fetched(self):
        self.assertNotIn("tokens_unstakeDone", ops_of(fetch.HE_USER_OPS))
        self.assertNotIn("tokens_undelegateDone", ops_of(fetch.HE_USER_OPS))


def ops_of(s):
    return s.split(",")


class Amounts(unittest.TestCase):
    """apply_criteria.to_units — this feeds the genesis ledger."""

    def test_ordinary_decimals(self):
        self.assertEqual(ac.to_units("1234.56780000"), 123456780000)
        self.assertEqual(ac.to_units("0"), 0)

    def test_scientific_notation_dust(self):
        # Hive-Engine emits "2E-8" for a single base unit.
        self.assertEqual(ac.to_units("2E-8"), 2)

    def test_missing_and_empty(self):
        self.assertEqual(ac.to_units(None), 0)
        self.assertEqual(ac.to_units(""), 0)

    def test_it_truncates_rather_than_rounds(self):
        # Rounding up here would create tokens that do not exist.
        self.assertEqual(ac.to_units("0.000000019"), 1)


class C6Rule(unittest.TestCase):
    """apply_criteria.evaluate — the rule that burns or migrates an account."""

    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.cutoff = self.now - timedelta(days=180)

    def bal(self, **kw):
        b = {"balance": "0", "stake": "0"}
        b.update(kw)
        return b

    def run_one(self, balance, activity):
        alive, dead, burned = ac.evaluate({"alice": balance}, {"alice": activity}, self.cutoff)
        return ("alive" if "alice" in alive else "dead" if "alice" in dead else "burned")

    def test_a_recent_lassecash_op_migrates(self):
        inside = (self.now - timedelta(days=10)).timestamp()
        self.assertEqual(self.run_one(self.bal(balance="100"),
                                      {"last_lassecash_ts": inside}), "alive")

    def test_an_old_lassecash_op_burns(self):
        outside = (self.now - timedelta(days=400)).timestamp()
        self.assertEqual(self.run_one(self.bal(balance="100"),
                                      {"last_lassecash_ts": outside}), "dead")

    def test_hive_activity_alone_does_NOT_save_you(self):
        # C6 dropped the Hive limb entirely on 2026-08-22. It is still recorded
        # for the audit trail; it must not make anyone eligible.
        self.assertEqual(self.run_one(
            self.bal(balance="100"),
            {"last_active_op_ts": self.now.isoformat()}), "dead")

    def test_an_unresolved_search_FAILS_OPEN(self):
        # Never burn on missing data: a truncated history walk means "not found
        # in the pages we read", not "proven absent". Deep-history posters are
        # exactly who this protects.
        self.assertEqual(self.run_one(self.bal(balance="100"),
                                      {"he_search_truncated": True}), "alive")

    def test_the_older_truncation_flag_is_honoured_too(self):
        self.assertEqual(self.run_one(self.bal(balance="100"),
                                      {"search_truncated": True}), "alive")

    def test_protocol_accounts_burn_by_name_whatever_they_did(self):
        alive, dead, burned = ac.evaluate(
            {"lassecash": self.bal(balance="7431834")},
            {"lassecash": {"last_lassecash_ts": self.now.timestamp()}},
            self.cutoff)
        self.assertIn("lassecash", burned)

    def test_every_holding_bucket_is_counted(self):
        # Found 2026-08-21/22: balance+stake alone missed 525k in unstaking
        # cooldowns, 101k delegated out, 553k in the Diesel pool and 50k in
        # open orders. Each of those is somebody's property.
        b = self.bal(balance="1", pooled="2", onOrder="4",
                     stake="8", pendingUnstake="16", delegationsOut="32")
        alive, _, _ = ac.evaluate({"alice": b},
                                  {"alice": {"last_lassecash_ts": self.now.timestamp()}},
                                  self.cutoff)
        r = alive["alice"]
        self.assertEqual(r["liquid"], ac.to_units("1") + ac.to_units("2") + ac.to_units("4"))
        self.assertEqual(r["staked"], ac.to_units("8") + ac.to_units("16") + ac.to_units("32"))
        self.assertEqual(r["total"], r["liquid"] + r["staked"])

    def test_delegations_IN_are_never_counted(self):
        # Stake delegated TO you is not yours. Counting it would credit it twice.
        b = self.bal(stake="10", delegationsIn="1000000")
        alive, _, _ = ac.evaluate({"alice": b},
                                  {"alice": {"last_lassecash_ts": self.now.timestamp()}},
                                  self.cutoff)
        self.assertEqual(alive["alice"]["staked"], ac.to_units("10"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
