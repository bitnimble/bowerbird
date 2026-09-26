//! The part of parking_lot's API rav1d uses, over `std::sync`.
//!
//! parking_lot parks threads on wasm only behind its `nightly` feature, and on stable its
//! `wasm32-wasip1-threads` build panics "Parking not supported on this platform" at the first
//! contended lock. std's primitives are futexes on `memory.atomic.wait32` there and work.
//!
//! Poisoning is ignored, as parking_lot has none. A guard holds its std guard in an `Option` so
//! `Condvar::wait` can hand it to std and put it back.

use std::fmt;
use std::ops::{Deref, DerefMut};
use std::sync;

fn unpoisoned<G>(result: sync::LockResult<G>) -> G {
    result.unwrap_or_else(sync::PoisonError::into_inner)
}

fn tried<G>(result: sync::TryLockResult<G>) -> Option<G> {
    match result {
        Ok(guard) => Some(guard),
        Err(sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(sync::TryLockError::WouldBlock) => None,
    }
}

#[derive(Default)]
pub struct Mutex<T: ?Sized>(sync::Mutex<T>);

impl<T> Mutex<T> {
    pub const fn new(value: T) -> Self {
        Mutex(sync::Mutex::new(value))
    }

    pub fn into_inner(self) -> T {
        unpoisoned(self.0.into_inner())
    }
}

impl<T: ?Sized> Mutex<T> {
    pub fn lock(&self) -> MutexGuard<'_, T> {
        MutexGuard(Some(unpoisoned(self.0.lock())))
    }

    pub fn try_lock(&self) -> Option<MutexGuard<'_, T>> {
        tried(self.0.try_lock()).map(|guard| MutexGuard(Some(guard)))
    }

    pub fn get_mut(&mut self) -> &mut T {
        unpoisoned(self.0.get_mut())
    }
}

impl<T: ?Sized + fmt::Debug> fmt::Debug for Mutex<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

pub struct MutexGuard<'a, T: ?Sized>(Option<sync::MutexGuard<'a, T>>);

impl<T: ?Sized> Deref for MutexGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0.as_ref().unwrap()
    }
}

impl<T: ?Sized> DerefMut for MutexGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        self.0.as_mut().unwrap()
    }
}

#[derive(Default)]
pub struct Condvar(sync::Condvar);

impl Condvar {
    pub const fn new() -> Self {
        Condvar(sync::Condvar::new())
    }

    pub fn wait<T>(&self, guard: &mut MutexGuard<'_, T>) {
        let held = guard.0.take().unwrap();
        guard.0 = Some(unpoisoned(self.0.wait(held)));
    }

    pub fn notify_one(&self) -> bool {
        self.0.notify_one();
        true
    }

    pub fn notify_all(&self) -> usize {
        self.0.notify_all();
        0
    }
}

impl fmt::Debug for Condvar {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Default)]
pub struct RwLock<T: ?Sized>(sync::RwLock<T>);

impl<T> RwLock<T> {
    pub const fn new(value: T) -> Self {
        RwLock(sync::RwLock::new(value))
    }

    pub fn into_inner(self) -> T {
        unpoisoned(self.0.into_inner())
    }
}

impl<T: ?Sized> RwLock<T> {
    pub fn read(&self) -> RwLockReadGuard<'_, T> {
        RwLockReadGuard(unpoisoned(self.0.read()))
    }

    pub fn write(&self) -> RwLockWriteGuard<'_, T> {
        RwLockWriteGuard(unpoisoned(self.0.write()))
    }

    pub fn try_read(&self) -> Option<RwLockReadGuard<'_, T>> {
        tried(self.0.try_read()).map(RwLockReadGuard)
    }

    pub fn try_write(&self) -> Option<RwLockWriteGuard<'_, T>> {
        tried(self.0.try_write()).map(RwLockWriteGuard)
    }

    pub fn get_mut(&mut self) -> &mut T {
        unpoisoned(self.0.get_mut())
    }
}

impl<T: ?Sized + fmt::Debug> fmt::Debug for RwLock<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

pub struct RwLockReadGuard<'a, T: ?Sized>(sync::RwLockReadGuard<'a, T>);

impl<'a, T: ?Sized> RwLockReadGuard<'a, T> {
    pub fn map<U: ?Sized, F: FnOnce(&T) -> &U>(guard: Self, f: F) -> MappedRwLockReadGuard<'a, U> {
        let target: *const U = f(&guard.0);
        MappedRwLockReadGuard { _held: Box::new(guard), target }
    }
}

impl<T: ?Sized> Deref for RwLockReadGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

pub struct RwLockWriteGuard<'a, T: ?Sized>(sync::RwLockWriteGuard<'a, T>);

impl<T: ?Sized> Deref for RwLockWriteGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

impl<T: ?Sized> DerefMut for RwLockWriteGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.0
    }
}

/// A read guard narrowed to part of what it guards. `_held` keeps the read lock for as long as
/// `target`, which points into the guarded value, is reachable.
pub struct MappedRwLockReadGuard<'a, U: ?Sized> {
    _held: Box<dyn 'a + Held>,
    target: *const U,
}

trait Held {}
impl<T: ?Sized> Held for RwLockReadGuard<'_, T> {}

impl<U: ?Sized> Deref for MappedRwLockReadGuard<'_, U> {
    type Target = U;
    fn deref(&self) -> &U {
        // SAFETY: `target` points into the value `_held`'s read lock guards, which outlives `self`.
        unsafe { &*self.target }
    }
}
