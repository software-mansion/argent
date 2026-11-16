// Adapters resolve some config paths from XDG_CONFIG_HOME before homedir().
// Tests redirect homedir() to a tmp dir, so a developer's real XDG_CONFIG_HOME
// would otherwise point those writes at their actual config.
delete process.env.XDG_CONFIG_HOME;
