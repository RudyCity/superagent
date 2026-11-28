// Bounded host lifetime and rotation accounting.
//
// The host is a long-lived helper. Bounding it limits the blast radius of any
// memory-safety or protocol defect in the native process: a fresh host is
// spawned after at most maxRequests served commands or maxLifetimeMs of wall
// clock time, whichever comes first.
//
// Rotation is announced in-band with a typed `rotating` line so the Core never
// mistakes a planned exit for a crash. The line is written before the request
// that would exceed the budget is served, which means a request is never lost:
// the Core re-issues it to the replacement host exactly once.
using System;
using System.Diagnostics;
using System.Globalization;

namespace DesktopHost
{
    internal enum BudgetDecision
    {
        Serve,
        Rotate,
        AlreadyRotating,
    }

    internal sealed class HostBudget
    {
        internal const string MaxRequestsEnvironmentVariable = "SUPERAGENT_DESKTOP_HOST_MAX_REQUESTS";
        internal const string MaxLifetimeEnvironmentVariable = "SUPERAGENT_DESKTOP_HOST_MAX_LIFETIME_MS";
        internal const long DefaultMaxRequests = 500;
        internal const long DefaultMaxLifetimeMs = 600000;
        internal const long MaxRequestsCeiling = 1000000;
        internal const long MaxLifetimeCeilingMs = 86400000;
        internal const string RequestCapReason = "request-cap";
        internal const string LifetimeReason = "lifetime";

        private readonly object _gate = new object();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly long _maxRequests;
        private readonly long _maxLifetimeMs;
        private long _servedRequests;
        private bool _requestInFlight;
        private bool _rotatingClaimed;

        private HostBudget(long maxRequests, long maxLifetimeMs)
        {
            _maxRequests = maxRequests;
            _maxLifetimeMs = maxLifetimeMs;
        }

        internal long MaxRequests
        {
            get { return _maxRequests; }
        }

        internal long MaxLifetimeMs
        {
            get { return _maxLifetimeMs; }
        }

        internal long ServedRequests
        {
            get
            {
                lock (_gate)
                {
                    return _servedRequests;
                }
            }
        }

        internal bool RotatingClaimed
        {
            get
            {
                lock (_gate)
                {
                    return _rotatingClaimed;
                }
            }
        }

        /// <summary>
        /// Reads and validates the process environment. Unset variables use the
        /// documented defaults; a set but malformed value is a startup error
        /// rather than a silent downgrade.
        /// </summary>
        internal static bool TryCreate(out HostBudget budget, out string error)
        {
            budget = null;
            error = null;
            long maxRequests;
            if (!TryReadEnvironmentValue(
                MaxRequestsEnvironmentVariable,
                DefaultMaxRequests,
                MaxRequestsCeiling,
                out maxRequests,
                out error))
            {
                return false;
            }
            long maxLifetimeMs;
            if (!TryReadEnvironmentValue(
                MaxLifetimeEnvironmentVariable,
                DefaultMaxLifetimeMs,
                MaxLifetimeCeilingMs,
                out maxLifetimeMs,
                out error))
            {
                return false;
            }
            budget = new HostBudget(maxRequests, maxLifetimeMs);
            return true;
        }

        private static bool TryReadEnvironmentValue(
            string name,
            long fallback,
            long ceiling,
            out long value,
            out string error)
        {
            value = fallback;
            error = null;
            string raw = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrEmpty(raw)) return true;
            string trimmed = raw.Trim();
            long parsed;
            if (trimmed.Length == 0 ||
                !long.TryParse(trimmed, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) ||
                parsed <= 0 ||
                parsed > ceiling)
            {
                error = "The environment variable " + name + " must be a positive integer no greater than " +
                    ceiling.ToString(CultureInfo.InvariantCulture) + ".";
                return false;
            }
            value = parsed;
            return true;
        }

        /// <summary>
        /// Reserve one command slot. When the cap or lifetime is already spent,
        /// the caller must write the rotation line and exit cleanly.
        /// </summary>
        internal BudgetDecision TryBeginRequest(out string reason)
        {
            reason = null;
            lock (_gate)
            {
                if (_rotatingClaimed) return BudgetDecision.AlreadyRotating;
                string expiredReason = ExpiredReason();
                if (expiredReason != null)
                {
                    _rotatingClaimed = true;
                    reason = expiredReason;
                    return BudgetDecision.Rotate;
                }
                _requestInFlight = true;
                return BudgetDecision.Serve;
            }
        }

        /// <summary>Record one served (or refused) command against the budget.</summary>
        internal void EndRequest()
        {
            lock (_gate)
            {
                _requestInFlight = false;
                _servedRequests++;
            }
        }

        /// <summary>
        /// Watchdog seam: claim an idle rotation when the budget expired while no
        /// command was in flight. Returns false when the main loop owns the exit.
        /// </summary>
        internal bool TryClaimIdleRotation(out string reason)
        {
            reason = null;
            lock (_gate)
            {
                if (_rotatingClaimed || _requestInFlight) return false;
                string expiredReason = ExpiredReason();
                if (expiredReason == null) return false;
                _rotatingClaimed = true;
                reason = expiredReason;
                return true;
            }
        }

        private string ExpiredReason()
        {
            if (_clock.ElapsedMilliseconds >= _maxLifetimeMs) return LifetimeReason;
            if (_servedRequests >= _maxRequests) return RequestCapReason;
            return null;
        }
    }
}
