// Same owner/System policy as windows-owner-only-acl.mjs, using the OS token.
// No elevation, owner takeover, shell policy change, or additional trustee.
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

class OwnerOnlyAcl {
    static int Check(FileSystemSecurity acl, bool directory, SecurityIdentifier owner) {
        var system = new SecurityIdentifier("S-1-5-18");
        if (!acl.GetOwner(typeof(SecurityIdentifier)).Equals(owner)) return 31;
        if (directory && !acl.AreAccessRulesProtected) return 32;
        bool ownerFull = false, systemFull = false;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            if (rule.AccessControlType != AccessControlType.Allow) return 33;
            var sid = rule.IdentityReference;
            if (!sid.Equals(owner) && !sid.Equals(system)) return 34;
            bool full = (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl;
            if (sid.Equals(owner) && full) ownerFull = true;
            if (sid.Equals(system) && full) systemFull = true;
        }
        return ownerFull && systemFull ? 0 : 35;
    }

    static int Main(string[] args) {
        try {
            if (args.Length != 2 || (args[0] != "0" && args[0] != "1") ||
                (args[1] != "0" && args[1] != "1")) return 20;
            string target = Console.In.ReadToEnd();
            if (!Path.IsPathRooted(target)) return 20;
            var attributes = File.GetAttributes(target);
            if ((attributes & FileAttributes.ReparsePoint) != 0) return 20;
            bool directory = args[0] == "1", apply = args[1] == "1";
            if (((attributes & FileAttributes.Directory) != 0) != directory) return directory ? 20 : 21;
            var owner = WindowsIdentity.GetCurrent().User;
            FileSystemSecurity acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(target) : File.GetAccessControl(target);
            int before = Check(acl, directory, owner);
            if (before == 0 || !apply || before == 31) return before;
            acl.SetAccessRuleProtection(true, false);
            foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                acl.RemoveAccessRuleSpecific(rule);
            foreach (var sid in new[] { owner, new SecurityIdentifier("S-1-5-18") })
                acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                    directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
                    PropagationFlags.None, AccessControlType.Allow));
            if (directory) Directory.SetAccessControl(target, (DirectorySecurity)acl);
            else File.SetAccessControl(target, (FileSecurity)acl);
            FileSystemSecurity after = directory ? (FileSystemSecurity)Directory.GetAccessControl(target) : File.GetAccessControl(target);
            return Check(after, directory, owner);
        } catch { return 1; }
    }
}
