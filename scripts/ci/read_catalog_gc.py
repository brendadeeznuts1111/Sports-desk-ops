"""Read a process-scoped catalog trace produced by trace_catalog_gc.sh."""
from pathlib import Path
import re
import sys


def summarize(directory):
    log = (directory / "catalog.log").read_text()
    if "Failure to open event" in log:
        raise ValueError("Perf dropped a requested event")
    launches = re.findall(r"^catalog-process pid=(\d+) revision=a7733435cf40429e3b35c36072769df2052b80f1$", log, re.M)
    collectors = set(re.findall(r"\[GC<(0x[0-9a-f]+)>:", log))
    if len(launches) != 1 or "catalog fresh:" not in log or len(collectors) != 1:
        raise ValueError("Expected one successfully completed catalog check on pinned Bun")
    pid = int(launches[0])
    progress = re.findall(r"^catalog-parsed (\d+) pid=(\d+) wall_ms=\d+$", log, re.M)
    if not progress or any((int(index), int(process)) != (i, pid)
                           for i, (index, process) in enumerate(progress, 1)):
        raise ValueError("Missing or ambiguous parser progress")

    # runConcurrentPhase is dispatched after the phase is committed. Stop counting
    # at the first finishChangingPhase entry, even when it turns out to be a no-op.
    # This bounds the witness strictly inside the phase and can undercount visits.
    addresses = {int(address, 16): name for name, address in
                 (line.split() for line in (directory / "events.txt").read_text().splitlines())}
    if set(addresses.values()) != {"concurrent", "transition", "visit"}:
        raise ValueError("Missing GC entry point metadata")
    first = None
    visits = []
    witness = None
    confirmed = total_visits = phases = transitions = cpu_samples = 0
    previous_ns = -1
    for line in (directory / "samples.txt").read_text().splitlines():
        if "PERF_RECORD_LOST" in line or "LOST_SAMPLES" in line:
            raise ValueError("Lost events invalidate phase attribution")
        sample = re.match(r"\s*(\d+)[/\s]+(\d+)\s+(\d+)\.(\d{9}):\s+(.+)", line)
        if not sample or int(sample[1]) != pid:
            continue
        tid = int(sample[2])
        instant = int(sample[3]) * 1_000_000_000 + int(sample[4])
        if instant < previous_ns:
            raise ValueError("Events are not ordered on the perf clock")
        previous_ns = instant
        breakpoint = re.match(r"mem:(0x[0-9a-f]+)\b", sample[5].lstrip())
        if not breakpoint:
            if sample[5].lstrip().startswith("cpu-clock"):
                cpu_samples += 1
            continue
        event = addresses[int(breakpoint[1], 16)]
        if event == "concurrent":
            phases += 1
            if first is None:
                first = instant
        elif event == "transition":
            transitions += 1
            if first is not None:
                for timestamp, worker in visits:
                    if first < timestamp < instant:
                        confirmed += 1
                        witness = witness or (first, timestamp, instant, worker)
            first = None
            visits.clear()
        elif tid != pid:
            total_visits += 1
            if first is not None:
                visits.append((instant, tid))

    if not cpu_samples or not transitions or first is not None:
        raise ValueError("Missing or incomplete process trace")
    if log.count(")...]") and not phases:
        raise ValueError("GC resumed but no native concurrent entry was recorded")
    print(f"PID {pid}: {len(progress)} files parsed, {log.count(')...]')} GC resumes, "
          f"{phases} concurrent-phase dispatches, {cpu_samples} user-mode CPU samples.")
    print(f"Background CodeBlock visitor entries: {total_visits}; strictly inside a confirmed phase: {confirmed}.")
    if witness:
        start, timestamp, stop, worker = witness
        print(f"Concurrent marking observed. TID {worker}: {start} < {timestamp} < {stop} ns (CLOCK_MONOTONIC).")
    else:
        print("No background CodeBlock visit was confirmed inside a concurrent interval.")


if __name__ == "__main__":
    summarize(Path(sys.argv[1]))
