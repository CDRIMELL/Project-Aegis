//! Session gate: the single place that decides whether the webview may reach persistent data.
//!
//! See ADR 0010. Until authentication is implemented (phase 9) the gate is opened once at startup
//! by [`SessionGate::open_without_authentication`]. That call is the one line a real login flow
//! replaces; every data command already goes through [`SessionGate::ensure_unlocked`].

use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::{AppError, AppResult};

#[derive(Debug, Default)]
pub struct SessionGate {
    unlocked: AtomicBool,
}

impl SessionGate {
    /// A new gate starts locked.
    pub fn new() -> Self {
        Self::default()
    }

    /// Interim behaviour for builds that have no authentication yet.
    pub fn open_without_authentication(&self) {
        self.unlocked.store(true, Ordering::SeqCst);
    }

    /// Closes the gate. Nothing calls this until auto-lock and logout exist (phase 9); it is kept
    /// so the gate's full behaviour is defined and tested from the start.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn lock(&self) {
        self.unlocked.store(false, Ordering::SeqCst);
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked.load(Ordering::SeqCst)
    }

    pub fn ensure_unlocked(&self) -> AppResult<()> {
        if self.is_unlocked() {
            Ok(())
        } else {
            Err(AppError::SessionLocked)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_locked_and_refuses_access() {
        let gate = SessionGate::new();
        assert!(!gate.is_unlocked());
        assert!(matches!(
            gate.ensure_unlocked(),
            Err(AppError::SessionLocked)
        ));
    }

    #[test]
    fn can_be_opened_and_locked_again() {
        let gate = SessionGate::new();
        gate.open_without_authentication();
        assert!(gate.ensure_unlocked().is_ok());
        gate.lock();
        assert!(gate.ensure_unlocked().is_err());
    }
}
