import os

Import("env")


def strip_quotes(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        return value[1:-1]
    return value


def c_string_escape(value):
    return value.replace("\\", "\\\\").replace('"', '\\"')


def parse_env(path):
    values = {}
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = strip_quotes(value.strip())
    return values


project_dir = env.subst("$PROJECT_DIR")
env_path = os.path.join(project_dir, "..", ".env")
include_dir = os.path.join(project_dir, "include")
secrets_path = os.path.join(include_dir, "secrets.h")

values = parse_env(env_path)

os.makedirs(include_dir, exist_ok=True)
with open(secrets_path, "w") as f:
    f.write("#pragma once\n")
    f.write('#define WIFI_SSID "%s"\n' % c_string_escape(values.get("WIFI_SSID", "")))
    f.write('#define WIFI_PASSWORD "%s"\n' % c_string_escape(values.get("WIFI_PASSWORD", "")))
    f.write('#define API_BASE_URL "%s"\n' % c_string_escape(values.get("API_BASE_URL", "")))

print("Generated %s from %s" % (secrets_path, env_path))
