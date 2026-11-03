// Fast child for the supervisor restart test: announces its pid, then idles.
console.log(`supervisor-mock-child:${process.pid}`);
await Bun.sleep(60_000);
