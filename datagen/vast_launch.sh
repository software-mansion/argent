#!/usr/bin/env bash
# Search cheapest matching vast.ai offer, create a training instance, wait for SSH. Prints the instance id
# on stdout (progress on stderr) so you can do:  ID=$(bash vast_launch.sh)
# Prereq: vastai set api-key <KEY>.  Env knobs: GPU, DISK, MAXPRICE, IMAGE.
set -euo pipefail
V=~/.local/bin/vastai
GPU="${GPU:-A100_PCIE}"; DISK="${DISK:-80}"; MAXPRICE="${MAXPRICE:-1.30}"
IMAGE="${IMAGE:-pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel}"
Q="gpu_name=$GPU num_gpus=1 disk_space>=$DISK inet_down>=200 dph_total<=$MAXPRICE reliability>0.98 verified=true rentable=true"
>&2 echo "=== search: $Q ==="
OFFERS=$($V search offers "$Q" -o 'dph_total+' --raw)
ID=$(echo "$OFFERS" | python3 -c "import sys,json;o=json.load(sys.stdin);print(o[0]['id'] if o else '')")
[ -z "$ID" ] && { >&2 echo "no offer matched; loosen filters (GPU=$GPU MAXPRICE=$MAXPRICE DISK=$DISK)"; exit 1; }
PRICE=$(echo "$OFFERS" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['dph_total'])")
>&2 echo "=== cheapest offer $ID @ \$$PRICE/hr -> create ($IMAGE, ${DISK}GB disk) ==="
NEW=$($V create instance "$ID" --image "$IMAGE" --disk "$DISK" --ssh --direct --label silver-train --raw)
INST=$(echo "$NEW" | python3 -c "import sys,json;print(json.load(sys.stdin).get('new_contract',''))" 2>/dev/null || echo "")
[ -z "$INST" ] && { >&2 echo "create failed: $NEW"; exit 1; }
>&2 echo "=== instance $INST created; waiting for SSH (up to ~10min) ==="
for i in $(seq 1 40); do
  S=$($V show instance "$INST" --raw 2>/dev/null | python3 -c \
      "import sys,json;d=json.load(sys.stdin);print(d.get('actual_status',''), d.get('ssh_host',''))" 2>/dev/null || echo "")
  st=$(echo "$S" | awk '{print $1}'); host=$(echo "$S" | awk '{print $2}')
  >&2 echo "  [$i] status=$st host=$host"
  if [ "$st" = "running" ] && [ -n "$host" ]; then
    >&2 echo "=== READY: $($V ssh-url "$INST") ==="; echo "$INST"; exit 0
  fi
  sleep 15
done
>&2 echo "timed out; check 'vastai show instances'"; echo "$INST"
