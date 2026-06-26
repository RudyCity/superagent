#!/usr/bin/env bash
# Analyze failed skills-search queries to identify missing skills

set -euo pipefail

SKILLS_DIR="${HOME}/.claude/skills"
LOG_FILE="${SKILLS_DIR}/.search-log.jsonl"

if [[ ! -f "$LOG_FILE" ]]; then
    echo "No search log found at $LOG_FILE"
    exit 0
fi

echo "Skills Search Gap Analysis"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Count total searches
total=$(wc -l < "$LOG_FILE")
echo "Total searches: $total"
echo ""

# Extract and count unique queries
echo "Most common searches:"
jq -r '.query' "$LOG_FILE" 2>/dev/null | sort | uniq -c | sort -rn | head -20

echo ""
echo "Recent searches (last 10):"
tail -10 "$LOG_FILE" | jq -r '"\(.timestamp) - \(.query)"' 2>/dev/null

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "High-frequency searches indicate missing skills."
echo "Review patterns and create skills as needed."
