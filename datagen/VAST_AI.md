# Training on vast.ai (replacing RunPod)

CLI installed: `~/.local/bin/vastai` (v1.1.3, on PATH). The training kernel, env pins, and packaging are
UNCHANGED — only the box-provisioning layer moves from `runpodctl` to `vastai`. Provide the API key and
run `vastai set api-key <KEY>` once; everything below then works.

> **Training box ≠ rollout box.** SFT/GRPO *training* runs fine on a stock vast.ai **pod** (unprivileged
> container — all it needs is the GPU). The RL **Android rollout fleet does NOT** — stock pods can't get
> `/dev/kvm` or `--privileged`, so it needs a root-capable **VM instance** (`vms_enabled=true`) or
> bare-metal. See RL_ENV.md "Rollout fleet". Budget rule: RL rollouts run local/free first; pay GPU only
> for the training update (memory `silver_compute_budget`).

## runpodctl → vastai mapping
| task | runpodctl | vastai |
|---|---|---|
| auth | (config) | `vastai set api-key <KEY>` |
| find GPU | `runpodctl gpu list` | `vastai search offers '<query>' -o 'dph+'` |
| create | `runpodctl pod create` | `vastai create instance <OFFER_ID> --image .. --disk .. --ssh --direct` |
| list | `runpodctl pod list` | `vastai show instances` |
| ssh | `runpodctl ssh info` | `vastai ssh-url <INSTANCE_ID>` |
| stop (keep disk) | `runpodctl pod stop` | `vastai stop instance <ID>` |
| logs | (ssh) | `vastai logs <ID>` |
| delete | `runpodctl pod delete` | `vastai destroy instance <ID>`  ← **deletes data, irreversible** |

## The offer query
vast.ai is a marketplace; you pick an OFFER (a specific host) by query, then create from its id.
```bash
# cheapest verified on-demand single A100 PCIe, >=80GB disk, decent bandwidth, <= $1.20/hr
vastai search offers 'gpu_name=A100_PCIE num_gpus=1 disk_space>=80 inet_down>=200 dph_total<=1.20' -o 'dph_total+'
# other useful fields: reliability>0.98, cuda_vers>=12.4, verified=true, datacenter=true
```
Take the `ID` column of the first row.

## Image (must match our flash_attn cp311/torch2.6 wheel)
Prefer a torch-2.6 / cuda-12.4 / **python-3.11** image so the pinned flash_attn wheel binds:
- `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel`  (torch 2.6 preinstalled, py3.11 — verify with `python -V`)
- proven fallback (what the RunPod runs used): `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`
  (we pip-install torch 2.6 on top anyway; see `silver_train_env_pins`).
If the image ships python != 3.11, swap the flash_attn wheel URL in `h100_train.py` to match (cpXY).

## End-to-end (identical training, new box)
```bash
vastai set api-key <KEY>
ID=$(bash vast_launch.sh)                 # search+create+wait, prints instance id (see helper)
SSH=$(vastai ssh-url "$ID")               # ssh://root@host:port
# stage + train exactly as on RunPod:
scp -P <port> h100_train.py root@<host>:/root/run/
#   pull data-v10 + (optional) resume checkpoint from HF on the box, then:
#   cd /root/run && DATA_DIR=./data MAXLEN=65536 MAX_STEPS=300 REORDER_THOUGHT=1 python h100_train.py
#   for a non-gemma base add: BASE=ornith BASE_MODEL=<hf/ornith-9b> MASK_*=... (see TRAINING_PATHS.md)
```

## Carry-over safety rules (same as RunPod, verified painfully)
- **Push every checkpoint to HF and verify the bytes BEFORE `stop`/`destroy`.** `destroy` deletes the disk;
  even `stop` can lose an ephemeral container disk. We lost the v10 ckpt-300 raw adapter to exactly this on
  RunPod (see `runpod_ephemeral_disk_loss` memory). A local pull is not a backup.
- A100 PCIe 80GB is the $/iteration sweet spot (training is bandwidth-bound). Bid/interruptible (`-i`) is
  cheaper but can be preempted mid-run — only with frequent HF checkpoint pushes.
- Watch the balance/burn; size the run to it (300 steps ≈ 11h ≈ ~$14 at ~$1.2/hr).

## Cost note
vast.ai bills storage separately and continues charging a **stopped** instance for its disk. `destroy` when
truly done (after HF push) to stop all charges.
