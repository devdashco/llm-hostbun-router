#!/bin/sh
# Fetch crazyrouter pricing and emit computed actual prices to /srv/prices.json
PRICING_URL="${PRICING_URL:-https://crazyrouter.com/api/pricing}"
OUT="${OUT:-/srv/prices.json}"
tmp="$(mktemp)"
if curl -fsS -m 25 "$PRICING_URL" -o "$tmp"; then
  jq '
    (.group_ratio.default // 1) as $g
    | { generated_at: (now|todate),
        source: "crazyrouter.com/api/pricing",
        group: "default", group_ratio: $g,
        unit: "USD; token models = per 1M tokens, others = per call (discount applied)",
        count: (.data|length),
        models: [ .data[] | (.discount // 1) as $d |
          if .quota_type==0 then
            { model: .model_name, type: "token",
              input_per_1m:  ((.model_ratio*2*$g*$d*100000|round)/100000),
              output_per_1m: ((.model_ratio*(.completion_ratio//1)*2*$g*$d*100000|round)/100000),
              discount: $d }
          else
            { model: .model_name, type: "per_call",
              price_per_call: ((.model_price*$g*$d*1000000|round)/1000000),
              discount: $d }
          end ] }
  ' "$tmp" > "$OUT" 2>/dev/null && echo "prices.json updated: $(jq '.count' "$OUT") models" || echo "jq transform failed"
else
  echo "pricing fetch failed; keeping existing $OUT" >&2
fi
rm -f "$tmp"
