import { installRedactingSnapshotSerializers } from "./serializers/redacting_snapshot_serializer.ts";

process.env.TZ = "UTC";
process.env.NO_COLOR = "1";

installRedactingSnapshotSerializers();
