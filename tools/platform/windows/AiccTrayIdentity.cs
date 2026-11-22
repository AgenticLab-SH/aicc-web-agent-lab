using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

// One source of truth for the native tray, window and installed file identity.
public static class AiccTrayIdentity {
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  static GraphicsPath Round(RectangleF r,float radius){
    float d=radius*2;var p=new GraphicsPath();
    p.AddArc(r.Left,r.Top,d,d,180,90);p.AddArc(r.Right-d,r.Top,d,d,270,90);
    p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.Left,r.Bottom-d,d,d,90,90);p.CloseFigure();return p;
  }
  public static Bitmap Render(int size,int state,bool highContrast,Color foreground,Color background){
    var bitmap=new Bitmap(size,size,PixelFormat.Format32bppArgb);
    using(var g=Graphics.FromImage(bitmap)){
      g.Clear(Color.Transparent);g.SmoothingMode=SmoothingMode.AntiAlias;
      g.CompositingQuality=CompositingQuality.HighQuality;g.ScaleTransform(size/64f,size/64f);
      var bounds=new RectangleF(2,2,60,60);
      using(var shape=Round(bounds,17)){
        if(highContrast){using(var brush=new SolidBrush(background))g.FillPath(brush,shape);}
        else using(var brush=new LinearGradientBrush(bounds,Color.FromArgb(73,155,224),Color.FromArgb(27,51,91),LinearGradientMode.ForwardDiagonal))g.FillPath(brush,shape);
        using(var pen=new Pen(highContrast?foreground:Color.FromArgb(183,225,255),1.5f))g.DrawPath(pen,shape);
        if(!highContrast&&size>=24){
          var save=g.Save();g.SetClip(shape);
          using(var brush=new LinearGradientBrush(new RectangleF(0,0,64,34),Color.FromArgb(65,Color.White),Color.FromArgb(0,Color.White),LinearGradientMode.Vertical))g.FillEllipse(brush,-12,-18,90,58);
          g.Restore(save);
        }
      }
      Color ink=highContrast?foreground:Color.FromArgb(240,249,255);
      Color route=highContrast?foreground:Color.FromArgb(145,213,255);
      using(var pen=new Pen(route,size<=20?3.6f:2.7f)){
        pen.StartCap=pen.EndCap=LineCap.Round;
        g.DrawLine(pen,19,20,31,31);g.DrawLine(pen,45,20,33,31);
        g.DrawLine(pen,19,45,31,33);g.DrawLine(pen,45,45,33,33);
      }
      using(var ring=new Pen(highContrast?foreground:Color.FromArgb(133,192,241),size<=20?2.6f:1.8f))g.DrawEllipse(ring,17,17,30,30);
      foreach(var node in new[]{new PointF(18,18),new PointF(46,18),new PointF(18,46),new PointF(46,46)}){
        using(var brush=new SolidBrush(ink))g.FillEllipse(brush,node.X-4.6f,node.Y-4.6f,9.2f,9.2f);
      }
      using(var hub=Round(new RectangleF(25,25,14,14),4)){
        using(var brush=new SolidBrush(ink))g.FillPath(brush,hub);
      }
      if(state>0){
        Color status=highContrast?foreground:state==1?Color.FromArgb(103,231,183):Color.FromArgb(255,188,104);
        using(var brush=new SolidBrush(highContrast?background:Color.FromArgb(27,51,91)))g.FillEllipse(brush,44,44,19,19);
        using(var brush=new SolidBrush(status))g.FillEllipse(brush,47,47,13,13);
        if(state==2){
          using(var pen=new Pen(highContrast?background:Color.FromArgb(70,39,16),2.2f))g.DrawLine(pen,53.5f,49.5f,53.5f,54.2f);
          using(var brush=new SolidBrush(highContrast?background:Color.FromArgb(70,39,16)))g.FillEllipse(brush,52.4f,56,2.2f,2.2f);
        }
      }
    }
    return bitmap;
  }
  public static Icon Create(int size,int state,bool highContrast,Color foreground,Color background){
    using(var bitmap=Render(Math.Max(16,size),state,highContrast,foreground,background)){
      var handle=bitmap.GetHicon();
      try{using(var original=Icon.FromHandle(handle))return (Icon)original.Clone();}
      finally{DestroyIcon(handle);}
    }
  }
  public static void WriteIcon(string file){
    int[] sizes={16,20,24,32,40,48,64,128,256};
    var frames=new List<byte[]>();
    foreach(int size in sizes)using(var bitmap=Render(size,0,false,Color.White,Color.Black))
      using(var buffer=new MemoryStream()){bitmap.Save(buffer,ImageFormat.Png);frames.Add(buffer.ToArray());}
    using(var stream=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None))
    using(var writer=new BinaryWriter(stream)){
      writer.Write((ushort)0);writer.Write((ushort)1);writer.Write((ushort)sizes.Length);
      int offset=6+sizes.Length*16;
      for(int i=0;i<sizes.Length;i++){
        writer.Write((byte)(sizes[i]==256?0:sizes[i]));writer.Write((byte)(sizes[i]==256?0:sizes[i]));
        writer.Write((byte)0);writer.Write((byte)0);writer.Write((ushort)1);writer.Write((ushort)32);
        writer.Write(frames[i].Length);writer.Write(offset);offset+=frames[i].Length;
      }
      foreach(var frame in frames)writer.Write(frame);
    }
  }
}