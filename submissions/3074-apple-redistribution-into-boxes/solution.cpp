class Solution {
public:
    int minimumBoxes(vector<int>& apple, vector<int>& capacity) {
        int ta=0;
        for (int i :apple){
            ta+=i;
        }
        sort(capacity.begin(),capacity.end());
        reverse(capacity.begin(),capacity.end());
        ta=ta*-1;
        int a=0;
        for (int i :capacity){
            ta+=i;
            a++;
            if (ta>=0){
                return a;
            }
            
        }
        return 0;
            }
};