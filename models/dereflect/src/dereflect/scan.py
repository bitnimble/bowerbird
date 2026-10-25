"""The selective scan LightRR runs in each of its four directions, in Triton, forward and backward, in
place of `mamba_ssm`'s CUDA kernel, which needs nvcc to build.

Sequences are contiguous, (B, 4, D, L): the caller lays each direction's order out first."""

import torch
import triton
import triton.language as tl

DIRECTIONS = 4
STATE = 16
TILE = 16
CHUNK_TILES = 32
BLOCK = 8
WARPS = 2


@triton.jit
def _linear(decay_1, drive_1, decay_2, drive_2):
    """`h = decay * h + drive` twice over, as one."""
    return decay_1 * decay_2, decay_2 * drive_1 + drive_2


@triton.jit
def _chunk_ends(
    u_ptr, delta_ptr, a_ptr, b_ptr, ends_ptr, spans_ptr,
    inner, steps, tiles, chunks,
    TILE: tl.constexpr, CHUNK_TILES: tl.constexpr, BLOCK: tl.constexpr, STATE: tl.constexpr,
):  # fmt: skip
    """Each chunk's state at its end from a zero start, and the sum of its `delta`."""
    lane = tl.program_id(0)
    k = lane % 4
    d = tl.program_id(1) * BLOCK + tl.arange(0, BLOCK)
    chunk = tl.program_id(2)
    t = tl.arange(0, TILE)
    s = tl.arange(0, STATE)
    live = d < inner
    a = tl.load(a_ptr + (k * inner + d)[:, None] * STATE + s[None, :], mask=live[:, None], other=0.0)
    sequence_at = (lane * inner + d) * steps
    shared_at = lane * STATE * steps + s * steps
    state = tl.zeros((BLOCK, STATE), dtype=tl.float32)
    span = tl.zeros((BLOCK,), dtype=tl.float32)
    for tile in range(chunk * CHUNK_TILES, tl.minimum((chunk + 1) * CHUNK_TILES, tiles)):
        at = tile * TILE + t
        inside = at < steps
        both = inside[:, None] & live[None, :]
        u = tl.load(u_ptr + sequence_at[None, :] + at[:, None], mask=both, other=0.0)
        dt = tl.load(delta_ptr + sequence_at[None, :] + at[:, None], mask=both, other=0.0)
        bv = tl.load(b_ptr + shared_at[None, :] + at[:, None], mask=inside[:, None], other=0.0)
        decay = tl.exp(dt[:, :, None] * a[None, :, :])
        drive = (dt * u)[:, :, None] * bv[:, None, :]
        through, local = tl.associative_scan((decay, drive), 0, _linear)
        h = through * state[None, :, :] + local
        state = tl.sum(tl.where((t == TILE - 1)[:, None, None], h, 0.0), axis=0)
        span += tl.sum(dt, axis=0)
    at_chunk = (lane * inner + d) * chunks + chunk
    tl.store(ends_ptr + at_chunk[:, None] * STATE + s[None, :], state, mask=live[:, None])
    tl.store(spans_ptr + at_chunk, span, mask=live)


@triton.jit
def _carry(
    a_ptr, ends_ptr, spans_ptr, entering_ptr,
    inner, chunks,
    BLOCK: tl.constexpr, STATE: tl.constexpr,
):  # fmt: skip
    """The state entering each chunk: the chunk before's end, plus the state before that decayed
    across it, whose decay is `exp(a * sum(delta))`."""
    lane = tl.program_id(0)
    k = lane % 4
    d = tl.program_id(1) * BLOCK + tl.arange(0, BLOCK)
    s = tl.arange(0, STATE)
    live = d < inner
    a = tl.load(a_ptr + (k * inner + d)[:, None] * STATE + s[None, :], mask=live[:, None], other=0.0)
    state = tl.zeros((BLOCK, STATE), dtype=tl.float32)
    for chunk in range(0, chunks):
        at_chunk = (lane * inner + d) * chunks + chunk
        tl.store(entering_ptr + at_chunk[:, None] * STATE + s[None, :], state, mask=live[:, None])
        end = tl.load(ends_ptr + at_chunk[:, None] * STATE + s[None, :], mask=live[:, None], other=0.0)
        span = tl.load(spans_ptr + at_chunk, mask=live, other=0.0)
        state = tl.exp(a * span[:, None]) * state + end


@triton.jit
def _forward(
    u_ptr, delta_ptr, a_ptr, b_ptr, c_ptr, skip_ptr, entering_ptr, y_ptr, saved_ptr,
    inner, steps, tiles, chunks,
    TILE: tl.constexpr, CHUNK_TILES: tl.constexpr, BLOCK: tl.constexpr, STATE: tl.constexpr,
):  # fmt: skip
    lane = tl.program_id(0)
    k = lane % 4
    d = tl.program_id(1) * BLOCK + tl.arange(0, BLOCK)
    chunk = tl.program_id(2)
    t = tl.arange(0, TILE)
    s = tl.arange(0, STATE)
    live = d < inner
    row = k * inner + d
    a = tl.load(a_ptr + row[:, None] * STATE + s[None, :], mask=live[:, None], other=0.0)
    skip = tl.load(skip_ptr + row, mask=live, other=0.0)
    sequence_at = (lane * inner + d) * steps
    shared_at = lane * STATE * steps + s * steps
    saved_at = saved_ptr + (lane * inner + d)[:, None] * tiles * STATE + s[None, :]
    at_chunk = (lane * inner + d) * chunks + chunk
    state = tl.load(entering_ptr + at_chunk[:, None] * STATE + s[None, :], mask=live[:, None], other=0.0)
    for tile in range(chunk * CHUNK_TILES, tl.minimum((chunk + 1) * CHUNK_TILES, tiles)):
        at = tile * TILE + t
        inside = at < steps
        both = inside[:, None] & live[None, :]
        u = tl.load(u_ptr + sequence_at[None, :] + at[:, None], mask=both, other=0.0)
        dt = tl.load(delta_ptr + sequence_at[None, :] + at[:, None], mask=both, other=0.0)
        bv = tl.load(b_ptr + shared_at[None, :] + at[:, None], mask=inside[:, None], other=0.0)
        cv = tl.load(c_ptr + shared_at[None, :] + at[:, None], mask=inside[:, None], other=0.0)
        tl.store(saved_at + tile * STATE, state, mask=live[:, None])
        decay = tl.exp(dt[:, :, None] * a[None, :, :])
        drive = (dt * u)[:, :, None] * bv[:, None, :]
        through, local = tl.associative_scan((decay, drive), 0, _linear)
        h = through * state[None, :, :] + local
        y = tl.sum(h * cv[:, None, :], axis=2) + skip[None, :] * u
        tl.store(y_ptr + sequence_at[None, :] + at[:, None], y, mask=both)
        # Steps past the end have no decay or drive, so the last row is the state at the end.
        state = tl.sum(tl.where((t == TILE - 1)[:, None, None], h, 0.0), axis=0)


@triton.jit
def _backward(
    u_ptr, delta_ptr, a_ptr, b_ptr, c_ptr, skip_ptr, saved_ptr, dy_ptr,
    du_ptr, ddelta_ptr, da_ptr, db_ptr, dc_ptr, dskip_ptr,
    inner, steps, tiles, blocks,
    TILE: tl.constexpr, BLOCK: tl.constexpr, STATE: tl.constexpr,
):  # fmt: skip
    lane = tl.program_id(0)
    k = lane % 4
    block = tl.program_id(1)
    d = block * BLOCK + tl.arange(0, BLOCK)
    t = tl.arange(0, TILE)
    s = tl.arange(0, STATE)
    live = d < inner
    row = k * inner + d
    a = tl.load(a_ptr + row[:, None] * STATE + s[None, :], mask=live[:, None], other=0.0)
    skip = tl.load(skip_ptr + row, mask=live, other=0.0)
    sequence_at = (lane * inner + d) * steps
    shared_at = lane * STATE * steps + s * steps
    partial_at = (lane * blocks + block) * STATE * steps + s * steps
    saved_at = saved_ptr + (lane * inner + d)[:, None] * tiles * STATE + s[None, :]
    carried = tl.zeros((BLOCK, STATE), dtype=tl.float32)
    da_sum = tl.zeros((BLOCK, STATE), dtype=tl.float32)
    dskip_sum = tl.zeros((BLOCK,), dtype=tl.float32)
    for back in range(0, tiles):
        tile = tiles - 1 - back
        at = tile * TILE + t
        inside = at < steps
        both = inside[:, None] & live[None, :]
        following = ((at + 1) < steps)[:, None] & live[None, :]
        u = tl.load(u_ptr + sequence_at[None, :] + at[:, None], mask=both, other=0.0)
        dt = tl.load(delta_ptr + sequence_at[None, :] + at[:, None], mask=both, other=0.0)
        dt_next = tl.load(delta_ptr + sequence_at[None, :] + at[:, None] + 1, mask=following, other=0.0)
        dy = tl.load(dy_ptr + sequence_at[None, :] + at[:, None], mask=both, other=0.0)
        bv = tl.load(b_ptr + shared_at[None, :] + at[:, None], mask=inside[:, None], other=0.0)
        cv = tl.load(c_ptr + shared_at[None, :] + at[:, None], mask=inside[:, None], other=0.0)
        entering = tl.load(saved_at + tile * STATE, mask=live[:, None], other=0.0)
        decay = tl.exp(dt[:, :, None] * a[None, :, :])
        drive = (dt * u)[:, :, None] * bv[:, None, :]
        through, local = tl.associative_scan((decay, drive), 0, _linear)
        h = through * entering[None, :, :] + local
        own = dy[:, :, None] * cv[:, None, :] + tl.where((t == TILE - 1)[:, None, None], carried[None, :, :], 0.0)
        decay_next = tl.exp(dt_next[:, :, None] * a[None, :, :])
        _, g = tl.associative_scan((decay_next, own), 0, _linear, reverse=True)
        # decay * h_before, without dividing by a decay that may be vanishingly small.
        held = g * (h - drive)
        da_sum += tl.sum(held * dt[:, :, None], axis=0)
        dskip_sum += tl.sum(dy * u, axis=0)
        g_b = tl.sum(g * bv[:, None, :], axis=2)
        tl.store(ddelta_ptr + sequence_at[None, :] + at[:, None], tl.sum(held * a[None, :, :], axis=2) + g_b * u, mask=both)
        tl.store(du_ptr + sequence_at[None, :] + at[:, None], dy * skip[None, :] + g_b * dt, mask=both)
        tl.store(db_ptr + partial_at[None, :] + at[:, None], tl.sum(g * (dt * u)[:, :, None], axis=1), mask=inside[:, None])
        tl.store(dc_ptr + partial_at[None, :] + at[:, None], tl.sum(dy[:, :, None] * h, axis=1), mask=inside[:, None])
        carried = tl.sum(tl.where((t == 0)[:, None, None], g * decay, 0.0), axis=0)
    tl.store(da_ptr + (lane * inner + d)[:, None] * STATE + s[None, :], da_sum, mask=live[:, None])
    tl.store(dskip_ptr + lane * inner + d, dskip_sum, mask=live)


class SelectiveScan(torch.autograd.Function):
    """`u` and `delta` (B, 4, D, L), `delta` after the softplus, `a` (4 D, N) already
    `-exp(A_logs)`, `b` and `c` (B, 4, N, L), `skip` (4 D), to `y` (B, 4, D, L), all float32."""

    @staticmethod
    def forward(ctx, u, delta, a, b, c, skip):  # type: ignore[override]
        batch, _, inner, steps = u.shape
        tiles = triton.cdiv(steps, TILE)
        partials = batch * DIRECTIONS * triton.cdiv(inner, BLOCK) * STATE * steps
        largest = max(u.numel(), batch * DIRECTIONS * inner * tiles * STATE, partials)
        if largest >= 2**31:
            raise ValueError(f"{largest} values overflow the scan's 32-bit offsets")
        chunks = triton.cdiv(tiles, CHUNK_TILES)
        lanes, blocks = batch * DIRECTIONS, triton.cdiv(inner, BLOCK)
        ends = torch.empty(batch, DIRECTIONS, inner, chunks, STATE, device=u.device)
        spans = torch.empty(batch, DIRECTIONS, inner, chunks, device=u.device)
        entering = torch.empty_like(ends)
        _chunk_ends[(lanes, blocks, chunks)](
            u, delta, a, b, ends, spans, inner, steps, tiles, chunks,
            TILE=TILE, CHUNK_TILES=CHUNK_TILES, BLOCK=BLOCK, STATE=STATE, num_warps=WARPS,
        )  # fmt: skip
        _carry[(lanes, blocks)](a, ends, spans, entering, inner, chunks, BLOCK=BLOCK, STATE=STATE, num_warps=WARPS)
        y = torch.empty_like(u)
        saved = torch.empty(batch, DIRECTIONS, inner, tiles, STATE, device=u.device)
        _forward[(lanes, blocks, chunks)](
            u, delta, a, b, c, skip, entering, y, saved, inner, steps, tiles, chunks,
            TILE=TILE, CHUNK_TILES=CHUNK_TILES, BLOCK=BLOCK, STATE=STATE, num_warps=WARPS,
        )  # fmt: skip
        ctx.save_for_backward(u, delta, a, b, c, skip, saved)
        return y

    @staticmethod
    def backward(ctx, dy):  # type: ignore[override]
        u, delta, a, b, c, skip, saved = ctx.saved_tensors
        batch, _, inner, steps = u.shape
        tiles = saved.shape[3]
        blocks = triton.cdiv(inner, BLOCK)
        du = torch.empty_like(u)
        ddelta = torch.empty_like(u)
        db = torch.empty(batch, DIRECTIONS, blocks, STATE, steps, device=u.device)
        dc = torch.empty_like(db)
        da = torch.empty(batch, DIRECTIONS, inner, STATE, device=u.device)
        dskip = torch.empty(batch, DIRECTIONS, inner, device=u.device)
        _backward[(batch * DIRECTIONS, blocks)](
            u, delta, a, b, c, skip, saved, dy.float().contiguous(),
            du, ddelta, da, db, dc, dskip,
            inner, steps, tiles, blocks,
            TILE=TILE, BLOCK=BLOCK, STATE=STATE, num_warps=WARPS,
        )  # fmt: skip
        return du, ddelta, da.sum(0).reshape(-1, STATE), db.sum(2), dc.sum(2), dskip.sum(0).reshape(-1)


def selective_scan(
    u: torch.Tensor, delta: torch.Tensor, a: torch.Tensor, b: torch.Tensor, c: torch.Tensor, skip: torch.Tensor
) -> torch.Tensor:
    return SelectiveScan.apply(*(t.float().contiguous() for t in (u, delta, a, b, c, skip)))


def reference(
    u: torch.Tensor, delta: torch.Tensor, a: torch.Tensor, b: torch.Tensor, c: torch.Tensor, skip: torch.Tensor
) -> torch.Tensor:
    """`selective_scan` one step at a time, as `selective_scan_ref` does, for checking against."""
    batch, _, inner, steps = u.shape
    a = a.reshape(DIRECTIONS, inner, STATE)
    skip = skip.reshape(DIRECTIONS, inner)
    state = u.new_zeros(batch, DIRECTIONS, inner, STATE)
    ys = []
    for step in range(steps):
        dt = delta[..., step]
        state = torch.exp(dt[..., None] * a) * state + (dt * u[..., step])[..., None] * b[:, :, None, :, step]
        ys.append((state * c[:, :, None, :, step]).sum(-1) + skip * u[..., step])
    return torch.stack(ys, -1)


def check() -> None:
    """The kernel against `reference`, values and every gradient, over sequences shorter than a tile,
    not a whole number of them, many of them, and several chunks, and channels that don't fill a block."""
    torch.manual_seed(0)
    for batch, inner, steps in ((2, 20, 13), (1, 33, 100), (1, 17, 1000), (1, 9, 3000)):
        inputs = [
            torch.randn(batch, DIRECTIONS, inner, steps),
            torch.nn.functional.softplus(torch.randn(batch, DIRECTIONS, inner, steps) - 1),
            -torch.exp(torch.randn(DIRECTIONS * inner, STATE)),
            torch.randn(batch, DIRECTIONS, STATE, steps),
            torch.randn(batch, DIRECTIONS, STATE, steps),
            torch.randn(DIRECTIONS * inner),
        ]
        weights = torch.randn(batch, DIRECTIONS, inner, steps, device="cuda")
        answers = []
        for scan in (selective_scan, reference):
            given = [t.cuda().requires_grad_() for t in inputs]
            y = scan(*given)
            (y * weights).sum().backward()
            answers.append([y.detach(), *(t.grad for t in given)])
        names = ["y", "du", "ddelta", "da", "db", "dc", "dskip"]
        for name, ours, wanted in zip(names, *answers):
            error = float((ours - wanted).abs().max() / wanted.abs().max())
            print(f"{batch}x{inner}x{steps} {name}: worst error {error:.2e} of the largest")
            assert error < 1e-4, f"{name} is {error:.2e} off"
    print("scan matches the reference")


if __name__ == "__main__":
    check()
