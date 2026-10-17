//! Answers a system call the process's seccomp policy refuses with `ENOSYS`, rather than letting
//! the SIGSYS it raises kill the process.
//!
//! Preloaded into the Android app's Bun: Android 11's app policy predates `close_range`, which Bun
//! calls at startup, and it traps rather than failing the call.

use std::ffi::{c_int, c_void};

#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
compile_error!(
    "seccomp_enosys sets the return register, which it names for aarch64 and x86_64 only"
);

/// `si_code` of a SIGSYS raised by a seccomp filter's trap.
const SYS_SECCOMP: c_int = 1;

#[used]
#[unsafe(link_section = ".init_array")]
static INSTALL: extern "C" fn() = install;

pub extern "C" fn install() {
    // SAFETY: a zeroed `sigaction` is a valid empty one, and the handler is async-signal-safe.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = refused as *const () as usize;
        action.sa_flags = libc::SA_SIGINFO;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGSYS, &action, std::ptr::null_mut());
    }
}

/// Seccomp's trap leaves the program counter past the call, so returning is the call returning.
extern "C" fn refused(_: c_int, info: *mut libc::siginfo_t, context: *mut c_void) {
    let enosys = -i64::from(libc::ENOSYS);
    // SAFETY: the kernel hands an `SA_SIGINFO` handler the signal's `siginfo_t` and the
    // interrupted thread's `ucontext_t`; `signal` and `raise` are async-signal-safe.
    unsafe {
        if (*info).si_code != SYS_SECCOMP {
            // Blocked while this runs, so the default action lands as the handler returns.
            libc::signal(libc::SIGSYS, libc::SIG_DFL);
            libc::raise(libc::SIGSYS);
            return;
        }
        let context = &mut *context.cast::<libc::ucontext_t>();
        #[cfg(target_arch = "aarch64")]
        {
            context.uc_mcontext.regs[0] = enosys as u64;
        }
        #[cfg(target_arch = "x86_64")]
        {
            context.uc_mcontext.gregs[libc::REG_RAX as usize] = enosys;
        }
    }
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
mod tests {
    use super::install;

    /// Traps `getppid` the way Android's policy traps `close_range`, in a child, since a filter
    /// lasts for the life of the process that loads it.
    #[test]
    fn a_refused_call_fails_with_enosys_instead_of_killing_the_process() {
        // SAFETY: the child only makes system calls and exits.
        let child = unsafe { libc::fork() };
        assert!(child >= 0, "fork failed");
        if child == 0 {
            install();
            let code = match trap_getppid() {
                Ok(()) => {
                    // SAFETY: a raw call with no arguments.
                    let returned = unsafe { libc::syscall(libc::SYS_getppid) };
                    let errno = std::io::Error::last_os_error().raw_os_error();
                    if returned == -1 && errno == Some(libc::ENOSYS) {
                        0
                    } else {
                        1
                    }
                }
                Err(()) => 2,
            };
            // SAFETY: leaves the forked child without running the parent's test harness.
            unsafe { libc::_exit(code) };
        }
        let mut status = 0;
        // SAFETY: waits for the child forked above.
        unsafe { libc::waitpid(child, &mut status, 0) };
        assert!(
            libc::WIFEXITED(status),
            "the child died of signal {}",
            libc::WTERMSIG(status)
        );
        assert_eq!(libc::WEXITSTATUS(status), 0, "1: not ENOSYS, 2: no filter");
    }

    fn trap_getppid() -> Result<(), ()> {
        const NR: u32 = 0;
        let program = [
            libc::sock_filter {
                code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
                jt: 0,
                jf: 0,
                k: NR,
            },
            libc::sock_filter {
                code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
                jt: 0,
                jf: 1,
                k: libc::SYS_getppid as u32,
            },
            libc::sock_filter {
                code: (libc::BPF_RET | libc::BPF_K) as u16,
                jt: 0,
                jf: 0,
                k: libc::SECCOMP_RET_TRAP,
            },
            libc::sock_filter {
                code: (libc::BPF_RET | libc::BPF_K) as u16,
                jt: 0,
                jf: 0,
                k: libc::SECCOMP_RET_ALLOW,
            },
        ];
        let filter = libc::sock_fprog {
            len: program.len() as u16,
            filter: program.as_ptr().cast_mut(),
        };
        // SAFETY: no-new-privs is what lets an unprivileged process load a filter, and the program
        // outlives the call that copies it into the kernel.
        let loaded = unsafe {
            libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0
                && libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &filter) == 0
        };
        if loaded { Ok(()) } else { Err(()) }
    }
}
