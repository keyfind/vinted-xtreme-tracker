export const RUN_MODES = ["search", "details"];

export function resolveRunMode(argv = process.argv.slice(2), env = process.env) {
  const index = argv.indexOf("--mode");
  const requested = index >= 0 ? argv[index + 1] : env.TRACKER_RUN_MODE || "details";
  if (!RUN_MODES.includes(requested)) throw new Error(`Ungültiger Laufmodus: ${requested}. Erlaubt sind search und details.`);
  return requested;
}
