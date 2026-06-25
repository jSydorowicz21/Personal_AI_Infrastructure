# llcli Quick Start

**The 30-second guide to using llcli**

## Installation

Already done. Located at: `$PAI_DIR/bin/llcli/`

## Usage

```bash
# Get help
$PAI_DIR/bin/llcli/llcli.ts --help

# Today's recordings
$PAI_DIR/bin/llcli/llcli.ts today

# Specific date
$PAI_DIR/bin/llcli/llcli.ts date 2025-11-17

# Search
$PAI_DIR/bin/llcli/llcli.ts search "consulting"

# With custom limit
$PAI_DIR/bin/llcli/llcli.ts today --limit 50
```

## Piping to jq

```bash
# Just titles
$PAI_DIR/bin/llcli/llcli.ts today | jq -r '.data.lifelogs[].title'

# Count recordings
$PAI_DIR/bin/llcli/llcli.ts date 2025-11-17 | jq '.data.lifelogs | length'

# Long recordings (>30 min)
$PAI_DIR/bin/llcli/llcli.ts today | jq '.data.lifelogs[] | select(
  ((.endTime | fromdateiso8601) - (.startTime | fromdateiso8601)) > 1800
)'
```

## Configuration

API key should be configured in the shared PAI config env file:
```bash
$PAI_CONFIG_DIR/.env
LIMITLESS_API_KEY=your_key
```

## Full Documentation

See: `$PAI_DIR/bin/llcli/README.md`
