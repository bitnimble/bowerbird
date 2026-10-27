//! No function that returns a struct by value may be called under a loop, in any shader.
//!
//! Metal's AIR-to-ISA backend drops such calls: past a pressure threshold that moves with the
//! caller's live state, every iteration after the first walks straight past the call site - the
//! callee never executes and the destination reads zeros. Measured on an M5 Pro, macOS 26, where a
//! constant frame came out at 0.64; the reduction lives with the Apple report.
//! The threshold cannot be pinned from WGSL - it depends on what else is live at the call and on
//! whether the compiler inlines, neither of which this side controls - so the rule is structural.
//!
//! The fix is an `out` parameter, which never failed at any width in any configuration:
//!
//! ```slang
//! void wht2d(out Block into, Block b) { into.r0 = ...; }
//! ```
//!
//! Inlined - the common case - the two forms compile to identical code, so the `out` form costs
//! nothing except where by-value would have been wrong.
//!
//! **A struct initializer list is the by-value form in disguise.** `into = { a, b }` compiles to a
//! synthesized `Struct_$init()` that returns the struct, so the fields are assigned one at a time
//! instead.
//!
//! "Under a loop" is transitive: a helper with no loop of its own runs once per iteration when its
//! caller sits in one, so reachability is propagated through the call graph. There is no recursion
//! and there are no function pointers, which makes that propagation exact.

use naga::{Module, Statement, TypeInner};
use std::collections::HashSet;

/// Call edges out of one body, each with whether the call statement sits inside a loop there.
fn calls(block: &naga::Block, in_loop: bool, out: &mut Vec<(naga::Handle<naga::Function>, bool)>) {
    for statement in block.iter() {
        match statement {
            Statement::Call { function, .. } => out.push((*function, in_loop)),
            Statement::Block(inner) => calls(inner, in_loop, out),
            Statement::If { accept, reject, .. } => {
                calls(accept, in_loop, out);
                calls(reject, in_loop, out);
            }
            Statement::Switch { cases, .. } => {
                for case in cases {
                    calls(&case.body, in_loop, out);
                }
            }
            Statement::Loop {
                body, continuing, ..
            } => {
                calls(body, true, out);
                calls(continuing, true, out);
            }
            _ => {}
        }
    }
}

fn violations(label: &str, module: &Module, out: &mut Vec<String>) {
    let struct_name = |function: &naga::Function| -> Option<String> {
        let result = function.result.as_ref()?;
        let ty = &module.types[result.ty];
        matches!(ty.inner, TypeInner::Struct { .. })
            .then(|| ty.name.clone().unwrap_or_else(|| "struct".to_string()))
    };
    let name_of = |handle: naga::Handle<naga::Function>| -> String {
        module.functions[handle]
            .name
            .clone()
            .unwrap_or_else(|| "<unnamed>".to_string())
    };

    // Every call edge: from arena functions, and from entry points (which cannot be callees).
    let mut edges: Vec<(
        String,
        Option<naga::Handle<naga::Function>>,
        naga::Handle<naga::Function>,
        bool,
    )> = Vec::new();
    for (handle, function) in module.functions.iter() {
        let mut found = Vec::new();
        calls(&function.body, false, &mut found);
        for (callee, in_loop) in found {
            edges.push((name_of(handle), Some(handle), callee, in_loop));
        }
    }
    for entry in &module.entry_points {
        let mut found = Vec::new();
        calls(&entry.function.body, false, &mut found);
        for (callee, in_loop) in found {
            edges.push((entry.name.clone(), None, callee, in_loop));
        }
    }

    // A function runs more than once when any of its call sites is in a loop, or when any caller
    // itself runs more than once. WGSL has no recursion, so this reaches a fixpoint.
    let mut loop_reached: HashSet<naga::Handle<naga::Function>> = HashSet::new();
    loop {
        let before = loop_reached.len();
        for (_, caller, callee, in_loop) in &edges {
            if *in_loop || caller.is_some_and(|c| loop_reached.contains(&c)) {
                loop_reached.insert(*callee);
            }
        }
        if loop_reached.len() == before {
            break;
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    for (caller_name, caller, callee, in_loop) in &edges {
        let function = &module.functions[*callee];
        let Some(returned) = struct_name(function) else {
            continue;
        };
        let under_loop = *in_loop || caller.is_some_and(|c| loop_reached.contains(&c));
        if !under_loop {
            continue;
        }
        let how = if *in_loop {
            "inside a loop in"
        } else {
            "from the loop-reached"
        };
        seen.insert(format!(
            "  {label}: `{}` returns `{returned}` by value and is called {how} `{caller_name}`",
            name_of(*callee),
        ));
    }
    let mut lines: Vec<_> = seen.into_iter().collect();
    lines.sort();
    out.extend(lines);
}

#[test]
fn no_struct_returns_under_a_loop() {
    let mut found = Vec::new();
    // Every module `build.rs` emitted: a stage links what it imports, so a file is a module on its
    // own and there is nothing to compose.
    for shader in shaders::ALL {
        let (label, source) = (shader.path, shader.source);
        let module = naga::front::wgsl::parse_str(source)
            .unwrap_or_else(|e| panic!("{label} does not parse: {}", e.emit_to_string(source)));
        violations(label, &module, &mut found);
    }
    assert!(
        found.is_empty(),
        "struct returned by value under a loop - Metal drops the call once enough is live; \
         write through an `out` parameter instead, field by field rather than with an \
         initializer list:\n{}",
        found.join("\n"),
    );
}
