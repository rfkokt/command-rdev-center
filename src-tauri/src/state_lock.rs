//! Serial order for state-writing commands.
//!
//! Synchronous Tauri commands used to run on the main thread, which made them
//! implicitly one-at-a-time, but every slow one (git, disk walks, network)
//! froze the window with the macOS beach ball. They now run off the main
//! thread; this lock keeps the old one-at-a-time order for commands that
//! read-modify-write config/state files, so two quick saves cannot interleave.
//!
//! The lock is reentrant per thread because some commands call others
//! directly (e.g. `add_workspace` -> `add_project`).

use std::cell::Cell;
use std::sync::{Mutex, MutexGuard};

static STATE_LOCK: Mutex<()> = Mutex::new(());

thread_local! {
    static DEPTH: Cell<u32> = const { Cell::new(0) };
}

pub(crate) struct StateWriteGuard {
    _guard: Option<MutexGuard<'static, ()>>,
}

impl Drop for StateWriteGuard {
    fn drop(&mut self) {
        DEPTH.with(|depth| depth.set(depth.get() - 1));
    }
}

/// Hold for the duration of a state-writing command. Never hold across an
/// `.await` (the guard is not `Send`); it is meant for synchronous commands.
pub(crate) fn state_write_lock() -> StateWriteGuard {
    let outer = DEPTH.with(|depth| {
        let current = depth.get();
        depth.set(current + 1);
        current == 0
    });
    StateWriteGuard {
        _guard: outer.then(|| STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner())),
    }
}

#[cfg(test)]
mod tests {
    use super::state_write_lock;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[test]
    fn is_reentrant_on_one_thread() {
        let _outer = state_write_lock();
        let _inner = state_write_lock(); // would deadlock with a plain Mutex
    }

    #[test]
    fn serializes_across_threads() {
        let inside = Arc::new(AtomicU32::new(0));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let inside = inside.clone();
                std::thread::spawn(move || {
                    let _lock = state_write_lock();
                    assert_eq!(inside.fetch_add(1, Ordering::SeqCst), 0);
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    inside.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
    }
}
