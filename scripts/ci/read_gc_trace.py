"""Summarize collection cycles enclosing the normal Linux test's mutation window."""
import re
import sys
from pathlib import Path


def summarize_trace(trace: str) -> str:
    launches = re.findall(r"^trace-process pid=(\d+) platform=Linux \S+ bun=1\.4\.4\+38afee6c8$", trace, re.M)
    markers = list(re.finditer(r"^array-mutation (begin|end) pid=(\d+) monotonic_ns=(\d+)$", trace, re.M))
    if len(launches) != 1 or [m[1] for m in markers] != ["begin", "end"]:
        raise ValueError("Missing or ambiguous pinned runtime or mutation boundaries")
    begin, end = markers
    if any(m[2] != launches[0] for m in markers) or int(end[3]) <= int(begin[3]):
        raise ValueError("Mutation boundaries must share the launched PID and advance in time")

    # Collector.cpp on this pin emits START before marking begins and END at
    # collection end. A cycle that intersects the markers needs finer evidence.
    collectors = set(re.findall(r"\[GC<(0x[\da-fA-F]+)>:", trace))
    if len(collectors) != 1:
        raise ValueError("Expected one collector in the captured process stream")
    events = re.finditer(r"\[GC<0x[\da-fA-F]+>: START |\bcycle [\d.]+ms END\]", trace)
    start = None
    cycles = 0
    intersecting = 0
    for event in events:
        if event[0].endswith("START "):
            if start is not None:
                raise ValueError("Nested GC cycle start")
            start = event.start()
        else:
            if start is None:
                raise ValueError("Unmatched GC cycle end")
            cycles += 1
            if start < end.start() and event.end() > begin.end():
                intersecting += 1
            start = None
    if not cycles or start is not None:
        raise ValueError("No complete GC trace")
    verdict = ("No recorded collection overlapped the mutation window."
               if intersecting == 0 else
               "A collection intersected the window. Concurrent marking overlap is inconclusive.")
    return (f"{verdict}\n\nPID {launches[0]}, mutation window {int(end[3]) - int(begin[3])} ns, "
            f"{cycles} complete GC cycles, {intersecting} intersecting.")


if __name__ == "__main__":
    print(summarize_trace(Path(sys.argv[1]).read_text()))
