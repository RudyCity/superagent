//! Windows Job Object: a receiver cannot outlive a crashed desktop GUI.
//! KILL_ON_JOB_CLOSE also terminates nested support commands created by Bun.
use std::mem::{size_of, zeroed};
use std::process::Child;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

pub struct JobGuard(HANDLE);
// The raw Windows HANDLE is exclusively owned by JobGuard and may be moved
// between threads; CloseHandle executes only once when the guard is dropped.
unsafe impl Send for JobGuard {}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0); }
        }
    }
}

impl JobGuard {
    pub fn attach(child: &mut Child) -> Result<Self, String> {
        fn create_and_assign(pid: u32) -> Result<JobGuard, String> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() { return Err("Cannot create Windows kill-on-exit job.".into()); }
                let owner = JobGuard(job);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0 {
                    return Err("Cannot enable kill-on-exit job limits.".into());
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() { return Err("Cannot verify spawned receiver process ownership.".into()); }
                let attached = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if attached == 0 { return Err("Cannot protect receiver process with Windows Job Object.".into()); }
                Ok(owner)
            }
        }
        match create_and_assign(child.id()) {
            Ok(job) => Ok(job),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        }
    }
}
