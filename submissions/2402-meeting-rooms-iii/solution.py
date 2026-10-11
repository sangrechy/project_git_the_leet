class Solution:
    def mostBooked(self, n: int, meetings: List[List[int]]) -> int:
        x=meetings
        x.sort()
        y=list(range(n))
        heapq.heapify(y)
        z=[]
        c=[0]*n
        for s,e in x:
            while z and z[0][0]<=s:
                f,r=heapq.heappop(z)
                heapq.heappush(y,r)
            if y:
                r=heapq.heappop(y)
                heapq.heappush(z,(e,r))
                c[r]+=1
            else:
                f,r=heapq.heappop(z)
                d=e-s
                heapq.heappush(z,(f+d,r))
                c[r]+=1
        m=max(c)
        for i,v in enumerate(c):
            if v==m:
                return i
