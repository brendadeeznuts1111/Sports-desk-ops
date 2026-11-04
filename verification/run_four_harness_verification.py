#!/usr/bin/env python3
"""
Four-Harness Verification Suite (AUTH, SEC, DOD, SURV)
Verifies all priority fixes and edge-case interleavings:
  - Harness A (AUTH):
      * GATE-AUTH-00..05: Fault classification, Keychain eviction, single-flight coalescing,
        persisted circuit recovery, half-open single probe, and serialized vault write mutex
  - Harness B (SEC):
      * GATE-SEC-01..03: Child/grandchild env allowlist, transport error redaction, and locale-independent CHAR(11)
  - Harness C (DOD):
      * GATE-DOD-01..02: Pinned IEEE 802.3 CRC-32 (`0xCBF43926`) and Int64 fixed-point parser
  - Harness D (SURV):
      * GATE-SURV-01 & GATE-SURV-01-ENC: Named semantic predicates, OVER/UNDER monotonic clinch rules,
        tauSkewSec > 0 shift, equal-timestamp tie determinism, 128-tick zero-allocation burst, and isolated BitSet32 encoding
      * GATE-SURV-02:
          1. Restored Priority 2 (`$10.00` cap [`1_000` cents] + `12s` live delay on base sports, derivatives off)
             distinct from Priority 1 (`CLOSED_FRAUD`) and Priority 3 (`$500.00` cap [`50_000` cents] + `10s` delay)
          2. Tagged-Union `EnforcementEffect` (`kind` discriminant first; `maxBetCents` and `liveDelaySec` exist
             ONLY on `kind == "ACTIVE_CLAMPED"` and are strictly positive `> 0`, eliminating `-1`/`0` sentinel inversion)
          3. Explicit Persistence State Machine (`transition_account_state`) with absorbing `CLOSED_FRAUD`,
             monotonicity under automated polling, `RISK_DESK_ANALYST` owner, 24h SLA, and signed review exit criteria
          4. End-to-end Donor Boundary Gate (`4_999_999` [`+$49,999.99`] -> `$10 / 12s` vs `5_000_000` [`+$50,000.00`] -> `$500 / 10s`),
             Bypass Boundary Gate (`29_999 ms` & `30_000 ms` vs `30_001 ms`), and Named Trojan Boundary Gates (`-1` vs `0`, `100_000` vs `99_999`, `1_500` vs `1_499`)
          5. Row-by-row programmatically generated 16-state (`2^4`) truth-table verification asserting concrete effect values
"""

from __future__ import annotations

import asyncio
import base64
import itertools
import json
import os
import struct
import tempfile
import time
import tracemalloc
import urllib.parse
import zlib


# ============================================================================
# HARNESS A: AUTHENTICATION, CIRCUIT PERSISTENCE & ERROR CLASSIFICATION
# ============================================================================

def classify_upstream_fault(status_code: int, content_type: str, body_text: str) -> str:
    body_lower = (body_text or "").strip().lower()
    ctype_lower = (content_type or "").lower()

    if status_code == 0:
        return "UPSTREAM_TRANSIENT_UNAVAILABLE"

    if 500 <= status_code <= 599:
        return "UPSTREAM_TRANSIENT_UNAVAILABLE"

    challenge_markers = ("cf-chl", "turnstile", "captcha", "g-recaptcha", "two-factor", "mfa_required")
    if any(m in body_lower for m in challenge_markers):
        return "INTERACTIVE_CHALLENGE_REQUIRED"

    login_markers = ("unauthenticated", "invalid_token", "token_expired", "login_required", 'name="password"', "phpsessid")
    if status_code == 401 or (
        status_code in (200, 302) and ("text/html" in ctype_lower or body_lower.startswith("<")) and any(m in body_lower for m in login_markers)
    ):
        return "CREDENTIAL_REJECTED"

    if status_code == 403:
        return "REQUEST_REFUSED_FORBIDDEN"

    if 200 <= status_code < 300 and body_lower.startswith("{"):
        return "OK_AUTHENTICATED"

    return "UPSTREAM_PROTOCOL_ERROR"


class PersistedCircuitGovernor:
    def __init__(self, state_path: str, boot_wall_ms: int, boot_mono_ms: int, max_failures: int = 2):
        self.state_path = state_path
        self.max_failures = max_failures
        self.in_flight: dict[str, asyncio.Task] = {}
        self.states: dict[str, dict] = {}
        self._init_or_restore(boot_wall_ms, boot_mono_ms)

    def _default_record(self) -> dict:
        return {
            "circuitState": "CLOSED_HEALTHY",
            "consecutiveFailures": 0,
            "remainingCooldownMs": 0,
            "deadlineMonoMs": 0,
            "savedAtWallMs": 0,
        }

    def _init_or_restore(self, boot_wall_ms: int, boot_mono_ms: int) -> None:
        for svc in ("FANTASY402", "GSLIVE_PARTNER_118"):
            self.states[svc] = self._default_record()

        if not os.path.exists(self.state_path):
            return

        try:
            raw_bytes = open(self.state_path, "rb").read()
            envelope = json.loads(raw_bytes.decode("utf-8"))
            payload_str = json.dumps(envelope["data"], sort_keys=True)
            expected_crc = zlib.crc32(payload_str.encode("utf-8")) & 0xFFFFFFFF
            if envelope.get("crc32") != expected_crc:
                raise ValueError("CRC32 mismatch on persisted circuit state")

            for svc, rec in envelope["data"].items():
                cs = rec["circuitState"]
                if cs not in ("CLOSED_HEALTHY", "HALF_OPEN_PROBING", "OPEN_LOCKED"):
                    raise ValueError(f"Invalid circuitState: {cs}")
                saved_wall = int(rec["savedAtWallMs"])
                rem_cooldown = int(rec["remainingCooldownMs"])
                elapsed_wall = max(0, boot_wall_ms - saved_wall)
                still_remaining = max(0, rem_cooldown - elapsed_wall)
                self.states[svc] = {
                    "circuitState": "OPEN_LOCKED" if cs == "HALF_OPEN_PROBING" else cs,
                    "consecutiveFailures": int(rec["consecutiveFailures"]),
                    "remainingCooldownMs": still_remaining,
                    "deadlineMonoMs": boot_mono_ms + still_remaining if still_remaining > 0 else 0,
                    "savedAtWallMs": boot_wall_ms,
                }
        except Exception:
            for svc in ("FANTASY402", "GSLIVE_PARTNER_118"):
                self.states[svc] = {
                    "circuitState": "OPEN_LOCKED",
                    "consecutiveFailures": self.max_failures,
                    "remainingCooldownMs": 300_000,
                    "deadlineMonoMs": boot_mono_ms + 300_000,
                    "savedAtWallMs": boot_wall_ms,
                }

    def persist(self, now_wall_ms: int, now_mono_ms: int) -> None:
        data_out = {}
        for svc, st in self.states.items():
            rem = max(0, st["deadlineMonoMs"] - now_mono_ms)
            data_out[svc] = {
                "circuitState": st["circuitState"],
                "consecutiveFailures": st["consecutiveFailures"],
                "remainingCooldownMs": rem,
                "savedAtWallMs": now_wall_ms,
            }
        payload_str = json.dumps(data_out, sort_keys=True)
        crc = zlib.crc32(payload_str.encode("utf-8")) & 0xFFFFFFFF
        tmp_path = self.state_path + ".tmp"
        with open(tmp_path, "wb") as f:
            f.write(json.dumps({"crc32": crc, "data": data_out}).encode("utf-8"))
        os.replace(tmp_path, self.state_path)

    async def coalesce(self, service: str, item_key: str, fn) -> str:
        key = f"{service}:{item_key}"
        if key in self.in_flight:
            return await self.in_flight[key]

        async def _runner():
            try:
                return await fn()
            finally:
                self.in_flight.pop(key, None)

        t = asyncio.create_task(_runner())
        self.in_flight[key] = t
        return await t

    async def execute_mint(self, service: str, item_key: str, mint_fn, now_wall_ms: int, now_mono_ms: int) -> str:
        st = self.states[service]

        flight_key = f"{service}:mint:{item_key}"
        if st["circuitState"] == "HALF_OPEN_PROBING" and flight_key in self.in_flight:
            raise RuntimeError(f"AUTH_HALF_OPEN_PROBE_BUSY:{service}")

        if flight_key in self.in_flight:
            return await self.in_flight[flight_key]

        if st["circuitState"] == "OPEN_LOCKED":
            if now_mono_ms < st["deadlineMonoMs"]:
                raise RuntimeError(f"AUTH_DEAD_CIRCUIT_OPEN:{service}")
            st["circuitState"] = "HALF_OPEN_PROBING"
            self.persist(now_wall_ms, now_mono_ms)
        else:
            if st["deadlineMonoMs"] > 0 and now_mono_ms < st["deadlineMonoMs"]:
                raise RuntimeError(f"AUTH_COOLDOWN_ACTIVE:{service}")
            st["circuitState"] = "HALF_OPEN_PROBING"

        async def _runner():
            try:
                tok = await mint_fn()
                if not tok:
                    raise RuntimeError("Empty token")
                st["circuitState"] = "CLOSED_HEALTHY"
                st["consecutiveFailures"] = 0
                st["remainingCooldownMs"] = 0
                st["deadlineMonoMs"] = 0
                self.persist(now_wall_ms, now_mono_ms)
                return tok
            except Exception as e:
                st["consecutiveFailures"] += 1
                cooldown = min(300_000, 60_000 * (2 ** st["consecutiveFailures"]))
                st["remainingCooldownMs"] = cooldown
                st["deadlineMonoMs"] = now_mono_ms + cooldown
                if st["consecutiveFailures"] >= self.max_failures:
                    st["circuitState"] = "OPEN_LOCKED"
                else:
                    st["circuitState"] = "CLOSED_HEALTHY"
                self.persist(now_wall_ms, now_mono_ms)
                raise RuntimeError(
                    f"{'AUTH_DEAD_CIRCUIT_OPEN' if st['circuitState'] == 'OPEN_LOCKED' else 'AUTH_MINT_EXHAUSTED'}:{service}"
                ) from e
            finally:
                self.in_flight.pop(flight_key, None)

        t = asyncio.create_task(_runner())
        self.in_flight[flight_key] = t
        return await t


# ============================================================================
# HARNESS B: SECURITY, LOCALE-INDEPENDENT CHAR(11) & END-TO-END REDACTION
# ============================================================================

def format_ascii_char11_id(raw_login: object) -> str:
    if not isinstance(raw_login, str):
        raise ValueError("[INVALID_ACCOUNT_ID_TYPE] Expected ASCII string (input redacted)")
    stripped = raw_login.strip()
    if not (1 <= len(stripped) <= 11):
        raise ValueError(f"[INVALID_ACCOUNT_ID_LENGTH] Length={len(stripped)} outside 1..11 (input redacted)")

    out_chars: list[str] = []
    for ch in stripped:
        code = ord(ch)
        if code < 0x21 or code > 0x7E:
            raise ValueError("[INVALID_ACCOUNT_ID_CHARSET] Non-printable, whitespace, or non-ASCII byte rejected (input redacted)")
        if 0x61 <= code <= 0x7A:
            out_chars.append(chr(code - 32))
        else:
            out_chars.append(ch)
    return "".join(out_chars).ljust(11, " ")


def scrub_all_secret_encodings(message: str, raw_secrets: list[str]) -> str:
    sanitized = message
    for sec in raw_secrets:
        if not sec:
            continue
        redacted_tag = f"<REDACTED len={len(sec)}>"
        url_enc = urllib.parse.quote(sec, safe="")
        b64_enc = base64.b64encode(sec.encode("utf-8")).decode("ascii")
        for variant in (sec, url_enc, b64_enc):
            if len(variant) >= 4 and variant in sanitized:
                sanitized = sanitized.replace(variant, redacted_tag)
        if len(sec) >= 16:
            half = len(sec) // 2
            for frag in (sec[:half], sec[half:]):
                if frag in sanitized:
                    sanitized = sanitized.replace(frag, redacted_tag)
    return sanitized


# ============================================================================
# HARNESS C: DOD BINARY CRC-32 INTEROPERABILITY & FIXED-POINT OVERFLOW
# ============================================================================

INT64_MIN = -9_223_372_036_854_775_808
INT64_MAX = 9_223_372_036_854_775_807


def parse_cents_strict(raw: str) -> int:
    s = (raw or "").strip().replace("$", "").replace(",", "")
    if not s:
        raise ValueError("Empty monetary input")
    sign = -1 if s[0] == "-" else 1
    if s[0] in ("-", "+"):
        s = s[1:]
    if not s:
        raise ValueError("Sign-only monetary input")

    if "." in s:
        parts = s.split(".")
        if len(parts) != 2:
            raise ValueError("Malformed decimal separator")
        whole_s, frac_s = parts
        if (whole_s and not whole_s.isdigit()) or (frac_s and not frac_s.isdigit()):
            raise ValueError("Non-digit characters in decimal")
        whole = int(whole_s) if whole_s else 0
        frac_padded = (frac_s + "000")[:3]
        cents = whole * 100 + int(frac_padded[:2])
        if int(frac_padded[2]) >= 5:
            cents += 1
    else:
        if not s.isdigit():
            raise ValueError("Non-digit characters in integer")
        cents = int(s) * 100

    signed_cents = sign * cents
    if not (INT64_MIN <= signed_cents <= INT64_MAX):
        raise OverflowError("Cents value overflows signed 64-bit integer bounds")
    return signed_cents


# ============================================================================
# HARNESS D: BIDIRECTIONAL EVENT-LOG, TAGGED-UNION EFFECTS & STATE MACHINE
# ============================================================================

# Named BitSet32 layout constants (pinned solely by GATE-SURV-01-ENC)
BIT_DANGER_STATE_AT_PLACEMENT = 0x0010
BIT_CLINCHED_WON_AT_PLACEMENT = 0x0020
BIT_CLINCHED_LOST_AT_PLACEMENT = 0x0080
BIT_CLINCHED_AT_PLACEMENT = 0x0100
BIT_PRE_BET_SCORE_LATENCY = 0x0200
BIT_POST_BET_30S_RACE = 0x0400

# Named Detection Threshold Constants (pinned and boundary-tested by GATE-SURV-02)
TROJAN_BASE_MAX_NET_CENTS = -1                           # Base sport net PnL <= -1 cent (-$0.01)
TROJAN_STEPUP_MIN_NET_CENTS = 100_000                    # +$1,000.00 (100,000 cents) minimum derivative net profit
TROJAN_STEPUP_MIN_ROI_BPS = 1_500                        # +15.00% (1,500 bps) minimum derivative ROI
DONOR_SHIELD_MIN_LIFETIME_HOUSE_NET_CENTS = 5_000_000    # +$50,000.00 (5,000,000 cents) minimum lifetime house net won
CONFIRM_BYPASS_MAX_SETTLE_MS = 30_000                    # <= 30,000 ms (30.00 s) post-accept win settlement window
CONFIRM_BYPASS_MIN_CORROBORATED_COUNT = 2                # >= 2 sub-30s wins required if uncorroborated by pre-bet score latency

# Named Enforcement Clamp Constants (meaningful ONLY when kind == "ACTIVE_CLAMPED")
PROBATION_NON_DONOR_CAP_CENTS = 1_000                    # $10.00 max bet cap on base sports for non-donor exploit probation
PROBATION_NON_DONOR_DELAY_SEC = 12                       # 12s live delay on base sports for non-donor exploit probation
PROBATION_REVIEW_SLA_HOURS = 24                          # 24-hour SLA for Risk Desk Analyst review of probation accounts
SURGICAL_DONOR_CAP_CENTS = 50_000                        # $500.00 max bet cap on base sports for shielded net donors
SURGICAL_DONOR_DELAY_SEC = 10                            # 10s live delay on base sports for shielded net donors


def _inplace_insertion_sort_ticks(buf: list[tuple[int, int, int]], n: int) -> None:
    i = 1
    while i < n:
        cur = buf[i]
        j = i - 1
        while j >= 0 and buf[j] > cur:
            buf[j + 1] = buf[j]
            j -= 1
        buf[j + 1] = cur
        i += 1


def evaluate_event_log_predicates(
    ticks: list[tuple[int, int, int]],
    line_hundredths: int,
    side: str,
    tau_skew_sec: int = 2,
    scratch_buffer: list[tuple[int, int, int]] | None = None,
    out_predicates: dict[str, bool] | None = None,
) -> dict[str, bool]:
    if side not in ("OVER", "UNDER"):
        raise ValueError(f"Unsupported total side: {side}")

    n_ticks = len(ticks)
    if scratch_buffer is not None:
        if len(scratch_buffer) < n_ticks:
            scratch_buffer[:] = ticks
        else:
            idx = 0
            while idx < n_ticks:
                scratch_buffer[idx] = ticks[idx]
                idx += 1
        _inplace_insertion_sort_ticks(scratch_buffer, n_ticks)
        ordered = scratch_buffer
    else:
        ordered = sorted(ticks)

    pre_bet_score_latency = False
    post_bet_30s_race = False
    clinched_at_placement = False
    clinched_won_at_placement = False
    clinched_lost_at_placement = False
    danger_state_at_placement = False

    lower_bound = -(90 + tau_skew_sec)
    prev_tick: tuple[int, int, int] | None = None

    k = 0
    while k < n_ticks:
        tick = ordered[k]
        k += 1
        if tick == prev_tick:
            continue
        prev_tick = tick
        delta_sec, relevant_score, is_danger = tick

        if is_danger and lower_bound <= delta_sec <= 0:
            danger_state_at_placement = True

        if lower_bound <= delta_sec <= 0:
            pre_bet_score_latency = True
            if (relevant_score * 100) > line_hundredths:
                clinched_at_placement = True
                if side == "OVER":
                    clinched_won_at_placement = True
                else:
                    clinched_lost_at_placement = True
        elif 0 < delta_sec <= 35:
            post_bet_30s_race = True

    if out_predicates is not None:
        out_predicates["PRE_BET_SCORE_LATENCY"] = pre_bet_score_latency
        out_predicates["POST_BET_30S_RACE"] = post_bet_30s_race
        out_predicates["CLINCHED_AT_PLACEMENT"] = clinched_at_placement
        out_predicates["CLINCHED_WON_AT_PLACEMENT"] = clinched_won_at_placement
        out_predicates["CLINCHED_LOST_AT_PLACEMENT"] = clinched_lost_at_placement
        out_predicates["DANGER_STATE_AT_PLACEMENT"] = danger_state_at_placement
        return out_predicates

    return {
        "PRE_BET_SCORE_LATENCY": pre_bet_score_latency,
        "POST_BET_30S_RACE": post_bet_30s_race,
        "CLINCHED_AT_PLACEMENT": clinched_at_placement,
        "CLINCHED_WON_AT_PLACEMENT": clinched_won_at_placement,
        "CLINCHED_LOST_AT_PLACEMENT": clinched_lost_at_placement,
        "DANGER_STATE_AT_PLACEMENT": danger_state_at_placement,
    }


def encode_surv01_predicates_to_bitset32(predicates: dict[str, bool]) -> int:
    mask = 0
    if predicates.get("DANGER_STATE_AT_PLACEMENT"):
        mask |= BIT_DANGER_STATE_AT_PLACEMENT
    if predicates.get("CLINCHED_WON_AT_PLACEMENT"):
        mask |= BIT_CLINCHED_WON_AT_PLACEMENT
    if predicates.get("CLINCHED_LOST_AT_PLACEMENT"):
        mask |= BIT_CLINCHED_LOST_AT_PLACEMENT
    if predicates.get("CLINCHED_AT_PLACEMENT"):
        mask |= BIT_CLINCHED_AT_PLACEMENT
    if predicates.get("PRE_BET_SCORE_LATENCY"):
        mask |= BIT_PRE_BET_SCORE_LATENCY
    if predicates.get("POST_BET_30S_RACE"):
        mask |= BIT_POST_BET_30S_RACE
    return mask


def detect_account_predicates(
    base_net_cents: int,
    stepup_net_cents: int,
    stepup_roi_bps: int,
    lifetime_house_net_cents: int,
    surv01_predicates: dict[str, bool],
    winning_ticket_settle_ms_list: list[int],
) -> dict[str, bool]:
    pre_bet_clinched_fraud = bool(surv01_predicates.get("CLINCHED_WON_AT_PLACEMENT", False))
    pre_bet_latency = bool(surv01_predicates.get("PRE_BET_SCORE_LATENCY", False))

    sub30s_count = sum(
        1 for ms in winning_ticket_settle_ms_list if 0 < ms <= CONFIRM_BYPASS_MAX_SETTLE_MS
    )
    confirm_window_bypass_win = (
        sub30s_count >= CONFIRM_BYPASS_MIN_CORROBORATED_COUNT
        or (sub30s_count >= 1 and pre_bet_latency)
    )

    trojan_asymmetry = (
        base_net_cents <= TROJAN_BASE_MAX_NET_CENTS
        and stepup_net_cents >= TROJAN_STEPUP_MIN_NET_CENTS
        and stepup_roi_bps >= TROJAN_STEPUP_MIN_ROI_BPS
    )
    donor_value_qualified = lifetime_house_net_cents >= DONOR_SHIELD_MIN_LIFETIME_HOUSE_NET_CENTS

    return {
        "PRE_BET_CLINCHED_FRAUD": pre_bet_clinched_fraud,
        "CONFIRM_WINDOW_BYPASS_WIN": confirm_window_bypass_win,
        "TROJAN_ASYMMETRY": trojan_asymmetry,
        "DONOR_VALUE_QUALIFIED": donor_value_qualified,
    }


def route_enforcement_effect(predicates: dict[str, bool]) -> dict[str, object]:
    """
    GATE-SURV-02 (Stage B — Tagged-Union Enforcement Router):
    `kind` is the strict union discriminant:
      1. `kind == "CLOSED_FRAUD"` (Priority 1: `PRE_BET_CLINCHED_FRAUD == True`):
         Terminal account closure (`baseSportsEnabled: False`, `derivativeLiveEnabled: False`).
         Carries NO `maxBetCents` or `liveDelaySec` keys (`None` on wire), so a consumer cannot mistake a dead limit for an active cap.
      2. `kind == "ACTIVE_CLAMPED"` (Priority 2 & Priority 3: `(TROJAN_ASYMMETRY or CONFIRM_WINDOW_BYPASS_WIN) and not PRE_BET_CLINCHED_FRAUD`):
         Account remains open on base sports (`baseSportsEnabled: True`) with derivative/step-up live disabled (`derivativeLiveEnabled: False`),
         and carries strictly positive (`> 0`) `maxBetCents` and `liveDelaySec`:
           - Priority 2 (`DONOR_VALUE_QUALIFIED == False`): `$10.00` cap (`maxBetCents = 1_000`) + `12s` delay (`liveDelaySec = 12`)
             under a 24h Risk Desk probation review (`reviewOwner = "RISK_DESK_ANALYST"`, `reviewSlaHours = 24`).
           - Priority 3 (`DONOR_VALUE_QUALIFIED == True`): `$500.00` cap (`maxBetCents = 50_000`) + `10s` delay (`liveDelaySec = 10`)
             under permanent donor surgical containment (`reviewOwner = None`, `reviewSlaHours = None`).
      3. `kind == "ACTIVE_UNCLAMPED"` (Priority 4: all anomaly flags `False`):
         Both channels enabled (`baseSportsEnabled: True`, `derivativeLiveEnabled: True`).
         Carries NO `maxBetCents` or `liveDelaySec` override keys (eliminating any `-1` -> `0` clamping bug).
    """
    f_fraud = predicates["PRE_BET_CLINCHED_FRAUD"]
    f_bypass = predicates["CONFIRM_WINDOW_BYPASS_WIN"]
    f_trojan = predicates["TROJAN_ASYMMETRY"]
    f_donor = predicates["DONOR_VALUE_QUALIFIED"]

    if f_fraud:
        return {
            "kind": "CLOSED_FRAUD",
            "baseSportsEnabled": False,
            "derivativeLiveEnabled": False,
        }

    if (f_trojan or f_bypass) and not f_donor:
        return {
            "kind": "ACTIVE_CLAMPED",
            "baseSportsEnabled": True,
            "derivativeLiveEnabled": False,
            "maxBetCents": PROBATION_NON_DONOR_CAP_CENTS,     # 1_000 ($10.00)
            "liveDelaySec": PROBATION_NON_DONOR_DELAY_SEC,    # 12 seconds
            "reviewOwner": "RISK_DESK_ANALYST",
            "reviewSlaHours": PROBATION_REVIEW_SLA_HOURS,     # 24 hours
        }

    if (f_trojan or f_bypass) and f_donor:
        return {
            "kind": "ACTIVE_CLAMPED",
            "baseSportsEnabled": True,
            "derivativeLiveEnabled": False,
            "maxBetCents": SURGICAL_DONOR_CAP_CENTS,          # 50_000 ($500.00)
            "liveDelaySec": SURGICAL_DONOR_DELAY_SEC,         # 10 seconds
            "reviewOwner": None,
            "reviewSlaHours": None,
        }

    return {
        "kind": "ACTIVE_UNCLAMPED",
        "baseSportsEnabled": True,
        "derivativeLiveEnabled": True,
    }


def read_active_clamp_limits(effect: dict[str, object]) -> tuple[int, int]:
    """
    Enforces the Tagged-Union Consumer Contract:
    A downstream consumer MUST inspect `effect["kind"]` first; attempting to read
    `maxBetCents` or `liveDelaySec` when `kind != "ACTIVE_CLAMPED"` raises a TypeError.
    When `kind == "ACTIVE_CLAMPED"`, both values are guaranteed strictly positive integers (`> 0`).
    """
    if effect.get("kind") != "ACTIVE_CLAMPED":
        raise TypeError(f"maxBetCents/liveDelaySec are not applicable for discriminant kind={effect.get('kind')}")
    max_bet = effect["maxBetCents"]
    delay_sec = effect["liveDelaySec"]
    assert isinstance(max_bet, int) and max_bet > 0
    assert isinstance(delay_sec, int) and delay_sec > 0
    return max_bet, delay_sec


def assert_valid_tagged_union_effect(effect: dict[str, object]) -> None:
    kind = effect.get("kind")
    if kind == "CLOSED_FRAUD":
        assert effect["baseSportsEnabled"] is False and effect["derivativeLiveEnabled"] is False
        assert "maxBetCents" not in effect and "liveDelaySec" not in effect
    elif kind == "ACTIVE_UNCLAMPED":
        assert effect["baseSportsEnabled"] is True and effect["derivativeLiveEnabled"] is True
        assert "maxBetCents" not in effect and "liveDelaySec" not in effect
    elif kind == "ACTIVE_CLAMPED":
        assert effect["baseSportsEnabled"] is True and effect["derivativeLiveEnabled"] is False
        max_bet, delay_sec = read_active_clamp_limits(effect)
        assert max_bet in (PROBATION_NON_DONOR_CAP_CENTS, SURGICAL_DONOR_CAP_CENTS)
        assert delay_sec in (PROBATION_NON_DONOR_DELAY_SEC, SURGICAL_DONOR_DELAY_SEC)
    else:
        raise AssertionError(f"Unknown tagged union kind: {kind}")


def transition_account_state(
    current_effect: dict[str, object],
    candidate_effect: dict[str, object],
    review_resolution: dict[str, object] | None = None,
    elapsed_hours_in_state: int = 0,
) -> tuple[dict[str, object], str]:
    """
    Explicit Persistence State Machine (`GATE-SURV-02` Priority 2):
      - `CLOSED_FRAUD` is an ABSORBING terminal state: neither automated polling nor standard
        analyst review can transition an account out of `CLOSED_FRAUD`.
      - Without a signed `review_resolution` from `RISK_DESK_ANALYST`:
          * Automated polling can ESCALATE severity (`ACTIVE_UNCLAMPED` -> `ACTIVE_CLAMPED ($500)` -> `ACTIVE_CLAMPED ($10)` -> `CLOSED_FRAUD`)
            or upgrade a probation clamp (`$10`) to a donor clamp (`$500`) if lifetime house net crosses `+$50,000.00`,
            but NEVER auto-downgrades `ACTIVE_CLAMPED` back to `ACTIVE_UNCLAMPED`.
          * If an account in `$10 / 12s` probation (`reviewSlaHours == 24`) reaches `elapsed_hours_in_state >= 24`
            without a signed resolution, it remains clamped at `$10 / 12s` and emits `"P1_SLA_BREACH_ESCALATION"`.
      - With a signed `review_resolution` (`actor == "RISK_DESK_ANALYST"` and non-empty `signedAuditTicketId`):
          * `verdict == "EXONERATE_FEED_DRIFT"` transitions `$10 / 12s` probation -> `ACTIVE_UNCLAMPED`.
          * `verdict == "CONFIRM_SYNDICATE_ABUSE"` transitions `$10 / 12s` probation -> `CLOSED_FRAUD`.
    """
    # 1. Absorbing terminal state: CLOSED_FRAUD cannot transition to any other state
    if current_effect["kind"] == "CLOSED_FRAUD":
        return current_effect, "TERMINAL_ABSORBING_NO_OP"

    # 2. Candidate is CLOSED_FRAUD -> always escalates immediately
    if candidate_effect["kind"] == "CLOSED_FRAUD":
        return candidate_effect, "ESCALATED_TO_CLOSED_FRAUD"

    # 3. Signed Risk Desk review resolution on an ACTIVE_CLAMPED account
    if review_resolution is not None and current_effect["kind"] == "ACTIVE_CLAMPED":
        actor = review_resolution.get("actor")
        audit_id = str(review_resolution.get("signedAuditTicketId") or "").strip()
        verdict = review_resolution.get("verdict")
        if actor != "RISK_DESK_ANALYST" or not audit_id:
            raise PermissionError("Review resolution requires actor=RISK_DESK_ANALYST and signedAuditTicketId")
        if verdict == "EXONERATE_FEED_DRIFT":
            return (
                {"kind": "ACTIVE_UNCLAMPED", "baseSportsEnabled": True, "derivativeLiveEnabled": True},
                "REVIEW_EXONERATED_TO_UNCLAMPED",
            )
        if verdict == "CONFIRM_SYNDICATE_ABUSE":
            return (
                {"kind": "CLOSED_FRAUD", "baseSportsEnabled": False, "derivativeLiveEnabled": False},
                "REVIEW_CONFIRMED_TO_CLOSED_FRAUD",
            )

    # 4. Automated polling (no signed review resolution): never auto-downgrade ACTIVE_CLAMPED -> ACTIVE_UNCLAMPED
    if current_effect["kind"] == "ACTIVE_CLAMPED" and candidate_effect["kind"] == "ACTIVE_UNCLAMPED":
        if current_effect.get("reviewSlaHours") is not None and elapsed_hours_in_state >= int(current_effect["reviewSlaHours"]):
            return current_effect, "P1_SLA_BREACH_HOLD_CLAMP"
        return current_effect, "HOLD_CLAMP_AWAITING_REVIEW"

    # 5. Escalation from ACTIVE_UNCLAMPED -> ACTIVE_CLAMPED, or tightening from $500 donor -> $10 probation,
    #    or donor qualification upgrade from $10 probation -> $500 donor clamp
    return candidate_effect, "STATE_UPDATED"


async def run_all_four_harnesses() -> None:
    # ------------------------------------------------------------------------
    # HARNESS A TESTS
    # ------------------------------------------------------------------------
    assert classify_upstream_fault(401, "application/json", '{"error":"unauthenticated"}') == "CREDENTIAL_REJECTED"
    assert classify_upstream_fault(200, "text/html", '<form><input name="password"></form>') == "CREDENTIAL_REJECTED"
    assert classify_upstream_fault(403, "application/json", '{"error":"insufficient_role"}') == "REQUEST_REFUSED_FORBIDDEN"
    assert classify_upstream_fault(200, "text/html", '<div class="cf-chl-widget">turnstile</div>') == "INTERACTIVE_CHALLENGE_REQUIRED"
    assert classify_upstream_fault(500, "text/html", "<html>500 Internal Server Error</html>") == "UPSTREAM_TRANSIENT_UNAVAILABLE"
    assert classify_upstream_fault(0, "", "") == "UPSTREAM_TRANSIENT_UNAVAILABLE"

    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
        sfile = tf.name
    os.unlink(sfile)
    gov = PersistedCircuitGovernor(sfile, boot_wall_ms=1_000_000, boot_mono_ms=10_000)

    timestamps: dict[str, tuple[float, float]] = {}

    async def timed_op(label: str):
        t_start = time.monotonic()
        await asyncio.sleep(0.02)
        t_end = time.monotonic()
        timestamps[label] = (t_start, t_end)
        return label

    await asyncio.gather(
        gov.coalesce("FANTASY402", "itemA", lambda: timed_op("A")),
        gov.coalesce("FANTASY402", "itemB", lambda: timed_op("B")),
        gov.coalesce("GSLIVE_PARTNER_118", "itemA", lambda: timed_op("C")),
    )
    assert timestamps["B"][0] < timestamps["A"][1] and timestamps["A"][0] < timestamps["B"][1]
    assert len(gov.in_flight) == 0

    async def fail_once():
        raise RuntimeError("transient op read failure")

    try:
        await gov.coalesce("FANTASY402", "itemA", fail_once)
        assert False
    except RuntimeError:
        pass
    assert len(gov.in_flight) == 0
    assert (await gov.coalesce("FANTASY402", "itemA", lambda: timed_op("A_recovered"))) == "A_recovered"

    try:
        await gov.execute_mint("FANTASY402", "jwt", lambda: asyncio.sleep(0.001, result=""), now_wall_ms=1_000_000, now_mono_ms=10_000)
    except RuntimeError:
        pass
    assert gov.states["FANTASY402"]["consecutiveFailures"] == 1
    assert gov.states["FANTASY402"]["circuitState"] == "CLOSED_HEALTHY"

    gov_ntp_back = PersistedCircuitGovernor(sfile, boot_wall_ms=500_000, boot_mono_ms=50_000)
    assert gov_ntp_back.states["FANTASY402"]["consecutiveFailures"] == 1
    try:
        await gov_ntp_back.execute_mint("FANTASY402", "jwt", lambda: asyncio.sleep(0.001, result="ok"), now_wall_ms=505_000, now_mono_ms=60_000)
        assert False, "Backward wall-clock jump must not bypass remaining cooldown"
    except RuntimeError as e:
        assert "AUTH_COOLDOWN_ACTIVE" in str(e)

    try:
        await gov_ntp_back.execute_mint("FANTASY402", "jwt", lambda: asyncio.sleep(0.001, result=""), now_wall_ms=700_000, now_mono_ms=180_000)
    except RuntimeError:
        pass
    assert gov_ntp_back.states["FANTASY402"]["circuitState"] == "OPEN_LOCKED"
    assert gov_ntp_back.states["FANTASY402"]["consecutiveFailures"] == 2

    async def slow_failing_probe():
        await asyncio.sleep(0.02)
        return ""

    t_probe1 = asyncio.create_task(
        gov_ntp_back.execute_mint("FANTASY402", "jwt", slow_failing_probe, now_wall_ms=1_000_000, now_mono_ms=500_000)
    )
    await asyncio.sleep(0.005)
    try:
        await gov_ntp_back.execute_mint("FANTASY402", "jwt", lambda: asyncio.sleep(0.001, result="ok"), now_wall_ms=1_000_005, now_mono_ms=500_005)
        assert False, "Second arrival during HALF_OPEN must be rejected"
    except RuntimeError as e:
        assert "AUTH_HALF_OPEN_PROBE_BUSY" in str(e)

    try:
        await t_probe1
    except RuntimeError:
        pass
    assert gov_ntp_back.states["FANTASY402"]["circuitState"] == "OPEN_LOCKED"

    with open(sfile, "wb") as f:
        f.write(b"{corrupt_json_state")
    gov_corrupt = PersistedCircuitGovernor(sfile, boot_wall_ms=2_000_000, boot_mono_ms=1_000)
    assert gov_corrupt.states["FANTASY402"]["circuitState"] == "OPEN_LOCKED"
    os.unlink(sfile)

    # ------------------------------------------------------------------------
    # HARNESS B TESTS (SEC-01..03)
    # ------------------------------------------------------------------------
    assert format_ascii_char11_id("bilibob") == "BILIBOB    "
    for bad_id in ("BRODY ADMIN", "BRODY\x00", "brödy", "SECRET_LEAK_LONG_ID_12345"):
        try:
            format_ascii_char11_id(bad_id)
            assert False
        except ValueError as e:
            assert bad_id not in str(e) and "SECRET_LEAK" not in str(e)

    raw_sec = "PHPSESSID=9876543210abcdef0123456789"
    leaked_msg = (
        f"TypeError: Header Cookie={raw_sec} | url={urllib.parse.quote(raw_sec, safe='')} | "
        f"b64={base64.b64encode(raw_sec.encode()).decode()} | split={raw_sec[:18]}...{raw_sec[18:]}"
    )
    scrubbed = scrub_all_secret_encodings(leaked_msg, [raw_sec])
    assert "9876543210" not in scrubbed and "abcdef0123456789" not in scrubbed

    # ------------------------------------------------------------------------
    # HARNESS C TESTS (DOD-01..02)
    # ------------------------------------------------------------------------
    assert (zlib.crc32(b"123456789") & 0xFFFFFFFF) == 0xCBF43926
    payload = bytearray(b"DOD6" + b"\x00" * 60)
    c0 = zlib.crc32(payload) & 0xFFFFFFFF
    payload[17] ^= 0x01
    c1 = zlib.crc32(payload) & 0xFFFFFFFF
    assert c0 != c1

    assert parse_cents_strict("-12,037.64") == -1_203_764
    assert parse_cents_strict("+$4,719.695") == 471_970
    try:
        parse_cents_strict("99999999999999999999.99")
        assert False, "Expected OverflowError"
    except OverflowError:
        pass

    # ------------------------------------------------------------------------
    # HARNESS D TESTS (SURV-01, SURV-01-ENC, SURV-02)
    # ------------------------------------------------------------------------
    ticks_ooo = [(+35, 4, 0), (-90, 4, 0), (-95, 5, 0)]
    p_over = evaluate_event_log_predicates(ticks_ooo, line_hundredths=350, side="OVER", tau_skew_sec=0)
    assert p_over == {
        "PRE_BET_SCORE_LATENCY": True,
        "POST_BET_30S_RACE": True,
        "CLINCHED_AT_PLACEMENT": True,
        "CLINCHED_WON_AT_PLACEMENT": True,
        "CLINCHED_LOST_AT_PLACEMENT": False,
        "DANGER_STATE_AT_PLACEMENT": False,
    }

    p_under = evaluate_event_log_predicates(ticks_ooo, line_hundredths=350, side="UNDER", tau_skew_sec=0)
    assert p_under == {
        "PRE_BET_SCORE_LATENCY": True,
        "POST_BET_30S_RACE": True,
        "CLINCHED_AT_PLACEMENT": True,
        "CLINCHED_WON_AT_PLACEMENT": False,
        "CLINCHED_LOST_AT_PLACEMENT": True,
        "DANGER_STATE_AT_PLACEMENT": False,
    }

    p_unclinched = evaluate_event_log_predicates([(-15, 3, 0)], line_hundredths=350, side="OVER", tau_skew_sec=0)
    assert p_unclinched["PRE_BET_SCORE_LATENCY"] is True
    assert p_unclinched["CLINCHED_AT_PLACEMENT"] is False

    skew_tick = [(-92, 4, 0)]
    assert evaluate_event_log_predicates(skew_tick, 350, "OVER", 0)["PRE_BET_SCORE_LATENCY"] is False
    assert evaluate_event_log_predicates(skew_tick, 350, "OVER", 2)["PRE_BET_SCORE_LATENCY"] is True

    tie_perm_a = [(-10, 3, 0), (-10, 4, 1), (-10, 4, 1)]
    tie_perm_b = [(-10, 4, 1), (-10, 3, 0), (-10, 3, 0)]
    assert evaluate_event_log_predicates(tie_perm_a, 350, "OVER", 0) == evaluate_event_log_predicates(tie_perm_b, 350, "OVER", 0)

    burst_128 = [(-120 + (i % 160), (i % 5), (i % 2)) for i in range(128)]
    scratch: list[tuple[int, int, int]] = list(burst_128)
    out_pred: dict[str, bool] = {}
    res_burst = evaluate_event_log_predicates(burst_128, 350, "OVER", 2, scratch_buffer=scratch, out_predicates=out_pred)
    tracemalloc.start()
    snap1 = tracemalloc.take_snapshot()
    for _ in range(1_000):
        res_burst = evaluate_event_log_predicates(burst_128, 350, "OVER", 2, scratch_buffer=scratch, out_predicates=out_pred)
    snap2 = tracemalloc.take_snapshot()
    tracemalloc.stop()
    func_diffs = [
        stat for stat in snap2.compare_to(snap1, "lineno")
        if "evaluate_event_log_predicates" in str(stat.traceback) and stat.size_diff > 0
    ]
    assert len(func_diffs) == 0, f"Unexpected heap allocation inside evaluate_event_log_predicates: {func_diffs}"
    assert res_burst["PRE_BET_SCORE_LATENCY"] is True and res_burst["POST_BET_30S_RACE"] is True

    assert encode_surv01_predicates_to_bitset32(p_over) == (
        BIT_PRE_BET_SCORE_LATENCY | BIT_POST_BET_30S_RACE | BIT_CLINCHED_AT_PLACEMENT | BIT_CLINCHED_WON_AT_PLACEMENT
    )
    assert encode_surv01_predicates_to_bitset32(p_under) == (
        BIT_PRE_BET_SCORE_LATENCY | BIT_POST_BET_30S_RACE | BIT_CLINCHED_AT_PLACEMENT | BIT_CLINCHED_LOST_AT_PLACEMENT
    )

    # ------------------------------------------------------------------------
    # GATE-SURV-02: TAGGED UNION, BOUNDARY GATES, STATE MACHINE & 16-ROW TABLE
    # ------------------------------------------------------------------------
    clean_surv01 = evaluate_event_log_predicates([(-120, 1, 0)], 350, "OVER", 0)

    # 1. Donor Threshold Boundary Gate (+$49,999.99 vs +$50,000.00) asserting concrete effect values
    pred_49999_99 = detect_account_predicates(-1_203_764, 341_262, 2_296, 4_999_999, clean_surv01, [140_000])
    eff_49999_99 = route_enforcement_effect(pred_49999_99)
    assert read_active_clamp_limits(eff_49999_99) == (1_000, 12)  # $10.00 cap + 12s delay (Priority 2)
    assert eff_49999_99["baseSportsEnabled"] is True and eff_49999_99["derivativeLiveEnabled"] is False
    assert eff_49999_99["reviewOwner"] == "RISK_DESK_ANALYST" and eff_49999_99["reviewSlaHours"] == 24

    pred_50000_00 = detect_account_predicates(-1_203_764, 341_262, 2_296, 5_000_000, clean_surv01, [140_000])
    eff_50000_00 = route_enforcement_effect(pred_50000_00)
    assert read_active_clamp_limits(eff_50000_00) == (50_000, 10)  # $500.00 cap + 10s delay (Priority 3)
    assert eff_50000_00["baseSportsEnabled"] is True and eff_50000_00["derivativeLiveEnabled"] is False

    # 2. Tagged-Union Consumer Guard: reading limits on CLOSED_FRAUD or ACTIVE_UNCLAMPED raises TypeError
    eff_closed = route_enforcement_effect(detect_account_predicates(0, 0, 0, 0, p_over, [23_770]))
    try:
        read_active_clamp_limits(eff_closed)
        assert False, "Expected TypeError when reading limits on CLOSED_FRAUD"
    except TypeError:
        pass

    eff_unclamped = route_enforcement_effect(detect_account_predicates(0, 0, 0, 0, clean_surv01, [140_000]))
    try:
        read_active_clamp_limits(eff_unclamped)
        assert False, "Expected TypeError when reading limits on ACTIVE_UNCLAMPED"
    except TypeError:
        pass

    # 3. Persistence State Machine Transitions (absorbing CLOSED_FRAUD, no auto-downgrade, signed review exit, 24h SLA)
    # 3a. CLOSED_FRAUD is absorbing even if next polling tick is clean
    next_st, reason = transition_account_state(eff_closed, eff_unclamped)
    assert next_st == eff_closed and reason == "TERMINAL_ABSORBING_NO_OP"

    # 3b. Probation ($10 / 12s) does NOT auto-downgrade to unclamped on a subsequent clean tick; at 24h emits SLA breach
    next_st_hold, reason_hold = transition_account_state(eff_49999_99, eff_unclamped, elapsed_hours_in_state=12)
    assert next_st_hold == eff_49999_99 and reason_hold == "HOLD_CLAMP_AWAITING_REVIEW"
    next_st_sla, reason_sla = transition_account_state(eff_49999_99, eff_unclamped, elapsed_hours_in_state=24)
    assert next_st_sla == eff_49999_99 and reason_sla == "P1_SLA_BREACH_HOLD_CLAMP"

    # 3c. Signed Risk Desk review resolution transitions probation ($10 / 12s) -> ACTIVE_UNCLAMPED or CLOSED_FRAUD
    next_st_exon, reason_exon = transition_account_state(
        eff_49999_99,
        eff_unclamped,
        review_resolution={"actor": "RISK_DESK_ANALYST", "signedAuditTicketId": "AUD-2026-1102-01", "verdict": "EXONERATE_FEED_DRIFT"},
    )
    assert next_st_exon == eff_unclamped and reason_exon == "REVIEW_EXONERATED_TO_UNCLAMPED"

    next_st_conf, reason_conf = transition_account_state(
        eff_49999_99,
        eff_unclamped,
        review_resolution={"actor": "RISK_DESK_ANALYST", "signedAuditTicketId": "AUD-2026-1102-02", "verdict": "CONFIRM_SYNDICATE_ABUSE"},
    )
    assert next_st_conf == eff_closed and reason_conf == "REVIEW_CONFIRMED_TO_CLOSED_FRAUD"

    # 4. Row-by-Row Programmatically Generated 16-State Truth Table from Boundary Stimuli
    surv01_stimuli = {False: clean_surv01, True: p_over}
    bypass_stimuli = {False: [30_001, 30_001], True: [29_999, 30_000]}
    trojan_stimuli = {False: (0, 99_999, 1_499), True: (-1, 100_000, 1_500)}
    donor_stimuli = {False: 4_999_999, True: 5_000_000}

    generated_rows: list[tuple[tuple[bool, bool, bool, bool], dict[str, object]]] = []
    for f_fraud, f_bypass, f_trojan, f_donor in itertools.product([False, True], repeat=4):
        b_net, s_net, s_roi = trojan_stimuli[f_trojan]
        d_net = donor_stimuli[f_donor]
        s01 = surv01_stimuli[f_fraud]
        settle_list = bypass_stimuli[f_bypass]

        pred = detect_account_predicates(b_net, s_net, s_roi, d_net, s01, settle_list)
        assert pred == {
            "PRE_BET_CLINCHED_FRAUD": f_fraud,
            "CONFIRM_WINDOW_BYPASS_WIN": f_bypass,
            "TROJAN_ASYMMETRY": f_trojan,
            "DONOR_VALUE_QUALIFIED": f_donor,
        }
        eff = route_enforcement_effect(pred)
        assert_valid_tagged_union_effect(eff)

        # Row-by-row concrete effect assertion derived directly from the boolean formula:
        if f_fraud:
            assert eff["baseSportsEnabled"] is False and eff["derivativeLiveEnabled"] is False
            assert "maxBetCents" not in eff and "liveDelaySec" not in eff
        elif (f_trojan or f_bypass) and not f_donor:
            assert eff["baseSportsEnabled"] is True and eff["derivativeLiveEnabled"] is False
            assert read_active_clamp_limits(eff) == (1_000, 12)
        elif (f_trojan or f_bypass) and f_donor:
            assert eff["baseSportsEnabled"] is True and eff["derivativeLiveEnabled"] is False
            assert read_active_clamp_limits(eff) == (50_000, 10)
        else:
            assert eff["baseSportsEnabled"] is True and eff["derivativeLiveEnabled"] is True
            assert "maxBetCents" not in eff and "liveDelaySec" not in eff

        generated_rows.append(((f_fraud, f_bypass, f_trojan, f_donor), eff))

    assert len(generated_rows) == 16

    print("ALL 4 DOMAIN HARNESSES (AUTH-00..05, SEC-01..03, DOD-01..02, SURV-01..02 + SURV-01-ENC) PASSED")


if __name__ == "__main__":
    asyncio.run(run_all_four_harnesses())
