//! Telling a running job to stop (§3.9).
//!
//! A job is one blocking call across the FFI, so cancelling one cannot mean interrupting Rust from
//! outside it: it means the library looking at a flag at the boundaries it already crosses. This
//! pins that the flag is seen *before* the work rather than after it, which is the difference
//! between cancel and "wait for it".

use rawshim::assembly_analysis::Refused;

/// A cancel set as an `analyse` starts is seen at its first boundary - before the device is even
/// asked for, let alone a frame decoded.
#[test]
fn analyse_stops_at_its_first_boundary_once_cancelled() {
    rawshim::progress::counted(true, || {
        rawshim::progress::cancel();
        match pollster::block_on(rawshim::assembly_analysis::analyse(&[])) {
            Err(refused) => assert_eq!(refused, Refused::Cancelled),
            Ok(_) => panic!("a cancelled analysis must not run to completion"),
        }
    });
}
