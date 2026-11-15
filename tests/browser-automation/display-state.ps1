# Print the console display state as Windows reports it to applications (Chrome's occlusion tracker
# listens to the same notification): off, on or dimmed. -Off first turns the display off the way the
# idle timeout does; a monitor switched off by its own button stays "on" for Windows.
param([switch]$Off)
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class DisplayState : NativeWindow {
  [StructLayout(LayoutKind.Sequential)]
  struct PowerBroadcastSetting { public Guid PowerSetting; public int DataLength; public int Data; }
  [DllImport("user32.dll")] static extern IntPtr RegisterPowerSettingNotification(IntPtr recipient, ref Guid setting, int flags);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
  static Guid ConsoleDisplayState = new Guid("6FE69556-704A-47A0-8F24-C28D936FDA47");
  int state = -1;

  // WM_SYSCOMMAND SC_MONITORPOWER 2 to HWND_BROADCAST.
  public static void TurnOff() { PostMessage(new IntPtr(0xffff), 0x112, new IntPtr(0xF170), new IntPtr(2)); }

  // Registering delivers the current state at once.
  public static string Read() {
    var window = new DisplayState();
    window.CreateHandle(new CreateParams { Parent = new IntPtr(-3) }); // HWND_MESSAGE
    RegisterPowerSettingNotification(window.Handle, ref ConsoleDisplayState, 0);
    for (var waited = 0; window.state < 0; waited += 10) {
      if (waited > 2000) throw new TimeoutException("no GUID_CONSOLE_DISPLAY_STATE notification");
      Application.DoEvents();
      System.Threading.Thread.Sleep(10);
    }
    return new[] { "off", "on", "dimmed" }[window.state];
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x218 && (int)m.WParam == 0x8013) // WM_POWERBROADCAST, PBT_POWERSETTINGCHANGE
      state = Marshal.PtrToStructure<PowerBroadcastSetting>(m.LParam).Data;
    base.WndProc(ref m);
  }
}
'@
if ($Off) { [DisplayState]::TurnOff() }
[DisplayState]::Read()
